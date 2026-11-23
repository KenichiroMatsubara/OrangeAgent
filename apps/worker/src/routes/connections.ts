import { LEGACY_AI_BASE_URL } from '../ai';
import { AI_BASE_URLS, aiProviderOf, isAiProvider, type AiProvider, type Connections } from '@mail/domain';
import { readConnection, saveConnection, type ConnectionCredential } from '../connections';
import { beginMicrosoftConnection, disconnectMicrosoft, microsoftConfigured, microsoftView } from '../microsoft';
import { AI_MODEL_LIMIT, aiModels, normalizedAiBaseUrl } from '../ai';
import { automationsNamingModels } from '../automations';
import type { Providers } from '../providers';
import { conflict, invalid, upstream } from '../refusal';
import { resource } from '../response';
import { readTranscriptionConnection, removeTranscriptionConnection, saveTranscriptionConnection, transcriptionView } from '../transcription';
import { accountRoute } from './account';

export const lineWebhookUrl = (appUrl: string, accountId: string): string =>
  `${appUrl.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/line/webhook`;

const lineView = (line: ConnectionCredential) => ({
  channelAccessTokenConfigured: Boolean(line.channelAccessToken),
  channelSecretConfigured: Boolean(line.channelSecret),
});

/** The provider a saved Connection is on, read from its Base URL's host; one saved before Base URLs were stored is Gemini's. */
const savedProvider = (ai: ConnectionCredential): AiProvider | null =>
  ai.baseUrl ? aiProviderOf(ai.baseUrl) : ai.apiKey ? aiProviderOf(LEGACY_AI_BASE_URL) : null;

/** What each provider's Connection is labelled in the Account's list of Connections. */
const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = { anthropic: 'Anthropic API', openai: 'OpenAI API', gemini: 'Gemini API', openrouter: 'OpenRouter' };

const aiView = (ai: ConnectionCredential): Connections['ai'] =>
  ({ apiKeyConfigured: Boolean(ai.apiKey), model: ai.model ?? '', models: aiModels(ai), provider: savedProvider(ai) });

/** The LINE, AI, Transcription, and Microsoft Connections of an Account: what is configured, never the secrets themselves. */
export const connectionRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/connections', accountRoute(async (request): Promise<Connections> => {
    const key = await request.key();
    const [line, ai, transcription, microsoft] = await Promise.all([
      readConnection({ db: request.db, key, accountId: request.accountId, kind: 'line' }),
      readConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai' }),
      readTranscriptionConnection(request.db, key, request.accountId),
      microsoftView(request.env, request.db, key, request.accountId),
    ]);
    return {
      accountId: request.accountId,
      accountName: request.account.name,
      line: { ...lineView(line), webhookUrl: lineWebhookUrl(request.env.APP_URL, request.accountId) },
      ai: aiView(ai),
      transcription: transcriptionView(transcription),
      microsoft,
    };
  }));

  routes.post('/organizations/:accountId/connections/microsoft/authorize', accountRoute(async (request) => {
    if (!microsoftConfigured(request.env)) throw conflict('Microsoft のアプリ（MICROSOFT_CLIENT_ID と MICROSOFT_CLIENT_SECRET）がこの環境に設定されていません。');
    return { authorizationUrl: await beginMicrosoftConnection(request.env, { accountId: request.accountId, identityId: request.session.identity_id }) };
  }));

  routes.delete('/organizations/:accountId/connections/microsoft', accountRoute(async (request): Promise<Connections['microsoft']> => {
    await disconnectMicrosoft(request.db);
    return { configured: microsoftConfigured(request.env), connected: false, email: null };
  }));

  routes.put('/organizations/:accountId/connections/transcription', accountRoute<{ apiKey?: unknown; model?: unknown }>(async (request): Promise<Connections['transcription']> => {
    const { apiKey, model } = request.body;
    if ((apiKey !== undefined && typeof apiKey !== 'string') || (model !== undefined && typeof model !== 'string')) throw invalid('API キーと model は文字で指定してください。');
    const saved = await saveTranscriptionConnection({ db: request.db, key: await request.key(), accountId: request.accountId, apiKey, model });
    return transcriptionView(saved);
  }));

  routes.delete('/organizations/:accountId/connections/transcription', accountRoute(async (request): Promise<Connections['transcription']> => {
    await removeTranscriptionConnection(request.db);
    return transcriptionView(null);
  }));

  routes.put('/organizations/:accountId/connections/line', accountRoute<{ channelAccessToken?: string; channelSecret?: string }>(async (request): Promise<Connections['line']> => {
    const key = await request.key();
    const current = await readConnection({ db: request.db, key, accountId: request.accountId, kind: 'line' });
    const next: ConnectionCredential = { ...current, ...request.body };
    if (!next.channelAccessToken || !next.channelSecret) throw invalid('LINEのチャネルアクセストークンとチャネルシークレットを両方入力してください。');
    await saveConnection({ db: request.db, key, accountId: request.accountId, kind: 'line', label: 'LINE Messaging API', credential: next });
    return { ...lineView(next), webhookUrl: lineWebhookUrl(request.env.APP_URL, request.accountId) };
  }));

  routes.put('/organizations/:accountId/connections/ai', accountRoute<{ provider?: unknown; apiKey?: string; model?: string; models?: unknown }>(async (request): Promise<Connections['ai']> => {
    const key = await request.key();
    const current = await readConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai' });
    const { models: named, provider: chosen, apiKey, model: defaultModel } = request.body;
    // The Base URL is the provider's own: only the four providers can be chosen, and none is typed.
    const before = savedProvider(current);
    if (chosen !== undefined && !isAiProvider(chosen)) throw invalid('接続先は Anthropic・OpenAI・Gemini・OpenRouter から選んでください。');
    const provider = chosen ?? before;
    if (!provider) throw invalid('接続先を Anthropic・OpenAI・Gemini・OpenRouter から選んでください。');
    const sameApi = provider === before;
    // A key is the provider's own, so moving to another provider needs that provider's key.
    if (!sameApi && !apiKey) throw invalid('接続先を変えるときは、その接続先の API キーを入力してください。');
    const next: ConnectionCredential = { ...current, ...(apiKey ? { apiKey } : {}), ...(defaultModel !== undefined ? { model: defaultModel } : {}) };
    const baseUrl = AI_BASE_URLS[provider];
    const model = next.model?.trim();
    if (!next.apiKey || !model) throw invalid('model と API キーを入力してください。');
    // Left out, the models chosen before are kept, unless the Connection now reaches another API, whose models they are not; the default is always among them, first.
    if (named !== undefined && (!Array.isArray(named) || named.some((entry) => typeof entry !== 'string'))) throw invalid('切り替えられるモデルはモデル名の一覧で指定してください。');
    const kept = sameApi ? current.models ?? '' : '';
    const models = aiModels({ model, models: named === undefined ? kept : (named as string[]).join('\n') });
    if (models.length > AI_MODEL_LIMIT) throw invalid(`切り替えられるモデルは ${AI_MODEL_LIMIT} 個までです。`);
    if (models.some((entry) => entry.length > 200 || /\s/u.test(entry))) throw invalid('モデル名に空白は使えません。1 行に 1 つずつ入力してください。');
    // A model an Automation names stays until that Automation names another, so no unattended run changes model unseen.
    const dropped = aiModels(current).filter((entry) => !models.includes(entry));
    const naming = await automationsNamingModels(request.db, dropped);
    if (naming.length) throw conflict(`${naming.map((entry) => `「${entry.name}」が ${entry.model}`).join('、')} を使っています。先に自動化のモデルを変えてください。`);
    next.provider = provider;
    next.model = model;
    next.models = models.join('\n');
    next.baseUrl = baseUrl;
    await saveConnection({ db: request.db, key, accountId: request.accountId, kind: 'ai', label: PROVIDER_LABELS[provider], credential: next });
    return aiView(next);
  }));

  routes.post('/organizations/:accountId/connections/ai/test', accountRoute<{ prompt?: string }>(async (request) => {
    const prompt = request.body.prompt?.trim() ?? '';
    if (!prompt) throw invalid('テスト用の質問を入力してください。');
    const credential = await readConnection({ db: request.db, key: await request.key(), accountId: request.accountId, kind: 'ai' });
    const model = credential.model?.trim();
    const baseUrl = normalizedAiBaseUrl(credential.baseUrl || LEGACY_AI_BASE_URL);
    if (!credential.apiKey || !model || !baseUrl) throw conflict('先に AI 接続を設定してください。');
    // Every API is tried as every run calls it, through Pi (ADR 0203).
    let turn: Awaited<ReturnType<typeof providers.ai.completeTurn>>;
    try {
      turn = await providers.ai.completeTurn({ apiKey: credential.apiKey, baseUrl, model, messages: [{ role: 'user', content: prompt }], tools: [] });
    } catch (error) {
      throw upstream(error instanceof Error ? error.message : 'AI が応答しませんでした。');
    }
    if (!turn.content.trim()) throw upstream('AI からテキスト応答を受け取れませんでした。');
    return { text: turn.content.trim(), model };
  }));

  return routes;
};
