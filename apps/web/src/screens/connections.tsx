import { Bot, CircleAlert, FileText, Mail, MessageCircle, MessagesSquare, Plus, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router-dom';

import { AI_PROVIDERS, CLAUDE_MODELS, DEFAULT_TRANSCRIPTION_MODEL, type AiProvider, modelLabel, modelNameProblem, type AccessToken, type AutomationStatus, type Connections, type ContactList, type McpEndpoint, type McpServer, type OperatorToken } from '@mail/domain';

import { AccessTokens } from '../access';
import { api } from '../api';
import { McpServers } from '../channel';
import { OperatorTokens } from '../cli';
import { accountIdOf, GoogleReauthenticationAction, useAccount } from '../dashboard';
import { DiscordSheet } from '../discord';
import { aiModelExample, aiProviderEnvironment, aiProviderName, inboxStatus, named } from '../labels';
import { useCopied } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { Button } from '../ui/button';
import { Segmented } from '../ui/choice';
import { Deferred, later } from '../ui/deferred';
import { Field, Secret } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner, Chip } from '../ui/notice';
import { Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import styles from './connections.module.css';

interface Shared {
  connections: Connections;
  automation: AutomationStatus | null;
}

interface Lent {
  contactLists: ContactList[];
  accessTokens: AccessToken[];
  mcpServers: McpServer[];
  operatorTokens: OperatorToken[];
  endpoint: McpEndpoint;
}

export interface ConnectionsData {
  shared: Promise<Shared>;
  lent: Promise<Lent>;
}

/** Returns at once; the credentials and what is lent to others fill in as they are read. */
export const loader = async (): Promise<ConnectionsData> => {
  const accountId = await accountIdOf();
  return {
    shared: later(Promise.all([api.connections(accountId), api.currentAutomation(accountId)]).then(([connections, automation]) => ({ connections, automation }))),
    lent: later(Promise.all([api.contactLists(accountId), api.accessTokens(accountId), api.mcpServers(accountId), api.operatorTokens(accountId), api.mcpEndpoint(accountId)])
      .then(([contactLists, accessTokens, mcpServers, operatorTokens, endpoint]) => ({ contactLists, accessTokens, mcpServers, operatorTokens, endpoint }))),
  };
};

const PROVIDER_OPTIONS = AI_PROVIDERS.map((provider) => ({ value: provider, label: aiProviderName[provider] }));

/** The saved Connection's provider in words, or what it is when it is none of the four. */
const providerWords = (provider: AiProvider | null): string => (provider ? aiProviderName[provider] : '以前の接続先');

/**
 * The models an AI Connection names, the default first: each listed with what
 * makes it the default or takes it off, a name typed to add another, and, for
 * Claude, the current models offered with one tap.
 */
const ModelList = ({ models, provider, onChange }: { models: string[]; provider: AiProvider | null; onChange: (models: string[]) => void }) => {
  const anthropic = provider === 'anthropic';
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const add = (model: string): void => {
    const name = model.trim();
    const refused = modelNameProblem(name, models);
    setProblem(refused);
    if (refused) return;
    onChange([...models, name]);
    setDraft('');
  };
  const suggested = anthropic ? CLAUDE_MODELS.filter((model) => !models.includes(model)) : [];
  return <section className={styles.models} aria-labelledby={`${inputId}-title`}>
    <h4 className={styles.modelsTitle} id={`${inputId}-title`}>使う model</h4>
    <p className={styles.modelsHint}>「AI に聞く」と自動化は、ここに並べた model から選べます。いちばん上が既定で、選ばなかったときに使われます。</p>
    {models.length === 0
      ? <Banner tone="warn">model を 1 つ以上登録するまで、AI 接続を保存できません。</Banner>
      : <ul className={styles.modelList} aria-label="登録した model">
        {models.map((model, index) => <li key={model} className={styles.modelRow}>
          <span className={styles.modelText}>
            <span className={styles.modelName}>{modelLabel(model)}{index === 0 && <> <Chip tone="brand">既定</Chip></>}</span>
            {modelLabel(model) !== model && <span className={styles.modelId}>{model}</span>}
          </span>
          {index > 0 && <Button variant="quiet" small onClick={() => onChange([model, ...models.filter((entry) => entry !== model)])} aria-label={`${modelLabel(model)} を既定にする`}>既定にする</Button>}
          <button type="button" className={styles.modelRemove} onClick={() => onChange(models.filter((entry) => entry !== model))} aria-label={`${modelLabel(model)} を外す`} title="外す"><X size={18} aria-hidden="true" /></button>
        </li>)}
      </ul>}
    {suggested.length > 0 && <div className={styles.suggestions} aria-label="追加できる Claude の model">
      {suggested.map((model) => <button key={model} type="button" className={styles.suggestion} onClick={() => add(model)} aria-label={`${modelLabel(model)} を追加`}><Plus size={16} aria-hidden="true" />{modelLabel(model)}</button>)}
    </div>}
    <label className={styles.addLabel} htmlFor={inputId}>{suggested.length > 0 ? 'ほかの model を名前で追加' : 'model を名前で追加'}</label>
    <div className={styles.addRow}>
      <input
        id={inputId}
        className={styles.addInput}
        value={draft}
        onChange={(change) => {
          setDraft(change.target.value);
          setProblem(null);
        }}
        onKeyDown={(key) => {
          if (key.key !== 'Enter' || key.nativeEvent.isComposing) return;
          key.preventDefault();
          add(draft);
        }}
        placeholder={provider ? aiModelExample[provider] : '例: gpt-5.5'}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${inputId}-problem` : undefined}
      />
      <Button variant="secondary" small icon={<Plus size={18} aria-hidden="true" />} disabled={!draft.trim()} onClick={() => add(draft)}>追加</Button>
    </div>
    {problem && <p className={styles.addProblem} id={`${inputId}-problem`}>{problem}</p>}
    <p className={styles.modelsHint}>自動化が使っている model は、その自動化の model を変えるまで外せません。</p>
  </section>;
};

/** The AI Connection, and a question sent through it to prove it answers. */
const ChatPart = ({ connections }: { connections: Connections }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [apiKey, setApiKey] = useState('');
  // The models that can be chosen, the default first.
  const saved = connections.ai.models.length > 0 ? connections.ai.models : [connections.ai.model].filter(Boolean);
  const [models, setModels] = useState<string[]>(saved);
  const [provider, setProvider] = useState<AiProvider | null>(connections.ai.provider);
  const [question, setQuestion] = useState('日本の首都を一文で教えてください。');
  const [answer, setAnswer] = useState('');
  const configured = connections.ai.apiKeyConfigured;
  const model = models[0] ?? '';
  // A key is its provider's own, so another provider is saved only with its key.
  const sameProvider = provider === connections.ai.provider;
  const changed = Boolean(apiKey || !sameProvider || models.join('\n') !== saved.join('\n'));
  const ready = Boolean(provider && model && (apiKey || (configured && sameProvider)));
  const choose = (next: AiProvider): void => {
    setProvider(next);
    // The models of one API are not another's: the saved ones come back only with the saved provider.
    setModels(next === connections.ai.provider ? saved : []);
  };
  const saving = operations.pending(pendingKey.aiConnection);
  const testing = operations.pending(pendingKey.aiTest);
  const save = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.aiConnection, async () => {
      if (!provider) return;
      await api.saveAiConnection(account.accountId, { provider, apiKey: apiKey || undefined, model, models });
      setApiKey('');
      await revalidator.revalidate();
    });
  };
  const test = (): void => void operations.run(pendingKey.aiTest, async () => {
    setAnswer('');
    setAnswer((await api.testAiConnection(account.accountId, question)).text);
  });
  const titleId = useId();
  return <form className={styles.part} onSubmit={save} aria-labelledby={titleId}>
    <h3 className={styles.partTitle} id={titleId}>チャットと自動化</h3>
    <Note>自動化とチャットに使う AI です。接続先を選んで、その API キーを入れます。どの接続先の AI もコードを動かし、「AI に聞く」で Word・Excel・PDF などのファイルを作れます。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {configured && !connections.ai.provider && <Banner tone="warn">保存済みの AI 接続は、ここで選べる 4 つ以外の接続先です。そのまま動き続けますが、保存し直すときは接続先を選び、その API キーを入れてください。</Banner>}
    <Segmented label="接続先" value={provider} options={PROVIDER_OPTIONS} onChange={choose} />
    {provider
      ? <p className={styles.modelsHint}>{aiProviderEnvironment[provider]}</p>
      : <p className={styles.modelsHint}>接続先を選んでください。</p>}
    <ModelList models={models} provider={provider} onChange={setModels} />
    <Secret
      label={provider ? `${aiProviderName[provider]} の API キー` : 'API キー'}
      value={apiKey}
      onChange={setApiKey}
      placeholder={configured && sameProvider ? '登録済み（変えるときだけ入力）' : 'API キー'}
    />
    <Button type="submit" block busy={saving} disabled={!changed || !ready}>{saving ? '保存しています…' : operations.settled(pendingKey.aiConnection) ? '保存しました' : 'AI 接続を保存'}</Button>
    {configured && <>
      <Field label="試しに質問する" hint={`保存済みの接続（${providerWords(connections.ai.provider)}）で送ります。`}>{(control) => <textarea {...control} rows={2} value={question} onChange={(change) => setQuestion(change.target.value)} />}</Field>
      <Button variant="secondary" busy={testing} onClick={test}>{testing ? '答えを待っています…' : '質問する'}</Button>
      {answer && <pre className={styles.answer}>{answer}</pre>}
    </>}
  </form>;
};

/**
 * The OpenRouter key and model a recording uploaded on 文字起こし is
 * transcribed with, kept apart from the AI Connection's key, and what follows
 * without it: no recording can be uploaded.
 */
const TranscriptionPart = ({ connections }: { connections: Connections }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const configured = connections.transcription.apiKeyConfigured;
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(connections.transcription.model || DEFAULT_TRANSCRIPTION_MODEL);
  const changed = Boolean(apiKey || (configured && model.trim() !== connections.transcription.model));
  const ready = Boolean(model.trim() && (apiKey || configured));
  const saving = operations.pending(pendingKey.transcriptionConnection);
  const removing = operations.pending(pendingKey.transcriptionRemoval);
  const save = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.transcriptionConnection, async () => {
      await api.saveTranscriptionConnection(account.accountId, { apiKey: apiKey || undefined, model: model.trim() });
      setApiKey('');
      await revalidator.revalidate();
    });
  };
  const remove = (): void => void operations.run(pendingKey.transcriptionRemoval, async () => {
    await api.removeTranscriptionConnection(account.accountId);
    await revalidator.revalidate();
  });
  const titleId = useId();
  return <form className={styles.part} onSubmit={save} aria-labelledby={titleId}>
    <h3 className={styles.partTitle} id={titleId}>文字起こし</h3>
    <Note>「<Link to="../transcripts">文字起こし</Link>」にアップロードした会議の録音を、OpenRouter で話者ごとに文字起こしします。上の接続先とは別に OpenRouter の API キーを使い、料金は OpenRouter で録音の長さに応じてかかります。議事録は上の既定の model が書きます。</Note>
    {!configured && <Banner tone="warn">登録するまで、録音を文字起こしできません。</Banner>}
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="文字起こしの model" hint={<>OpenRouter のモデル名を提供元から書きます。話者を分けられるモデルだけが使えます（例: {DEFAULT_TRANSCRIPTION_MODEL}、x-ai/grok-stt-1.0）。</>}>{(control) => <input {...control} value={model} onChange={(change) => setModel(change.target.value)} placeholder={DEFAULT_TRANSCRIPTION_MODEL} autoCapitalize="none" spellCheck={false} />}</Field>
    <Secret label="文字起こし用の OpenRouter の API キー" value={apiKey} onChange={setApiKey} placeholder={configured ? '登録済み（変えるときだけ入力）' : 'sk-or-…'} />
    <Button type="submit" block busy={saving} disabled={!changed || !ready}>{saving ? '保存しています…' : operations.settled(pendingKey.transcriptionConnection) ? '保存しました' : '文字起こしを保存'}</Button>
    {configured && <Button variant="secondary" busy={removing} onClick={remove}>{removing ? '外しています…' : '文字起こしを外す'}</Button>}
  </form>;
};

/**
 * Everything the Account's AI is reached with on one sheet: the Connection
 * Automations and Operator Chat think with, and the OpenRouter key recordings
 * are transcribed with. Each is saved by its own button.
 */
const AiSheet = ({ connections, onClose }: { connections: Connections; onClose: () => void }) =>
  <Sheet title="AI" onClose={onClose}>
    <ChatPart connections={connections} />
    <TranscriptionPart connections={connections} />
  </Sheet>;

/** The AI row's line: the provider and models it thinks with, and whether recordings can be transcribed. */
const aiSummary = (connections: Connections): string => {
  const { ai, transcription } = connections;
  const transcribing = transcription.apiKeyConfigured ? '文字起こし あり' : '文字起こし なし';
  if (!ai.apiKeyConfigured) return transcription.apiKeyConfigured ? `AI に頼むには必要です ・ ${transcribing}` : 'AI に頼むには必要です';
  // Non-breaking spaces keep the count on one line when the row wraps.
  const more = ai.models.length > 1 ? ` ほか\u00a0${ai.models.length - 1}\u00a0個` : '';
  return `${providerWords(ai.provider)} ・ ${modelLabel(ai.model)}${more} ・ ${transcribing}`;
};

/** LINE Messaging API credentials, and where LINE must send its webhook. */
const LineSheet = ({ connections, onClose }: { connections: Connections; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const { copied, copy } = useCopied();
  const [accessToken, setAccessToken] = useState('');
  const [secret, setSecret] = useState('');
  const { channelAccessTokenConfigured, channelSecretConfigured, webhookUrl } = connections.line;
  const ready = Boolean((accessToken || channelAccessTokenConfigured) && (secret || channelSecretConfigured));
  const saving = operations.pending(pendingKey.lineConnection);
  const save = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.lineConnection, async () => {
      await api.saveLineConnection(account.accountId, { channelAccessToken: accessToken || undefined, channelSecret: secret || undefined });
      setAccessToken('');
      setSecret('');
      await revalidator.revalidate();
    });
  };
  return <Sheet title="LINE" onClose={onClose} onSubmit={save}>
    <Note>LINE での通知と、LINE から届いた相手を見つけるのに使います。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Secret label="チャネルアクセストークン" value={accessToken} onChange={setAccessToken} placeholder={channelAccessTokenConfigured ? '登録済み（変えるときだけ入力）' : 'チャネルアクセストークン'} />
    <Secret label="チャネルシークレット" value={secret} onChange={setSecret} placeholder={channelSecretConfigured ? '登録済み（変えるときだけ入力）' : 'チャネルシークレット'} />
    <Button type="submit" block busy={saving} disabled={!(accessToken || secret) || !ready}>{saving ? '保存しています…' : operations.settled(pendingKey.lineConnection) ? '保存しました' : 'LINE を保存'}</Button>
    <Field label="Webhook URL" hint={<>LINE Developers の「Messaging API 設定」で、この URL を Webhook URL に貼って検証し、Webhook の利用をオンにします。届いた相手は<Link to="../contacts">連絡先</Link>に並びます。</>}>{(control) => <input {...control} value={webhookUrl} readOnly aria-label="LINE Webhook URL" />}</Field>
    <Toolbar><Button variant="secondary" small disabled={!webhookUrl} onClick={() => copy(webhookUrl)} aria-label="Webhook URLをコピー">{copied ? 'コピーしました' : 'コピー'}</Button></Toolbar>
    {webhookUrl && !webhookUrl.startsWith('https://') && <Banner tone="warn">localhost には LINE から届きません。本番の公開 HTTPS URL を設定してください。</Banner>}
  </Sheet>;
};

/** The Microsoft account whose Office for the web renders the PDFs Claude makes, and what follows without one. */
const MicrosoftSheet = ({ connections, onClose }: { connections: Connections; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const { configured, connected, email } = connections.microsoft;
  const busy = operations.pending(pendingKey.microsoftConnection);
  const connect = (): void => void operations.run(pendingKey.microsoftConnection, async () => {
    window.location.assign((await api.connectMicrosoft(account.accountId)).authorizationUrl);
  });
  const disconnect = (): void => void operations.run(pendingKey.microsoftConnection, async () => {
    await api.disconnectMicrosoft(account.accountId);
    await revalidator.revalidate();
  });
  return <Sheet title="Microsoft" onClose={onClose}>
    <Note>「AI に聞く」で作った Word・Excel・PowerPoint を PDF にするときに使います。つなぐと Microsoft の Office が PDF にするので、Word で開いたときと同じ見た目になります。つながないときは Google ドライブが PDF にします（日本語はきれいに出ますが、レイアウトが少し変わることがあります）。Microsoft がうまくいかなかったときも Google が代わりに作ります。</Note>
    <Note>FlareChat が触れるのは、OneDrive の中の FlareChat 専用のフォルダだけです。PDF にするあいだだけファイルを置き、すぐ消します。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {!configured && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>この環境には Microsoft のアプリが登録されていないため、つなげません。運営者が Microsoft Entra でアプリを登録し、そのアプリケーション ID とシークレットを Worker に設定すると使えるようになります。それまでは Google ドライブが PDF にします。</Banner>}
    {connected && <Field label="つないでいるアカウント">{(control) => <input {...control} value={email ?? '（メールアドレス不明）'} readOnly />}</Field>}
    {configured && <Button block busy={busy} onClick={connect}>{connected ? '別のアカウントでつなぎ直す' : 'Microsoft につなぐ'}</Button>}
    {connected && <Button variant="secondary" block busy={busy} onClick={disconnect}>切断する</Button>}
  </Sheet>;
};

type Sheets = 'ai' | 'line' | 'microsoft' | 'discord' | null;

/** What the Microsoft consent screen sent the administrator back to say. */
const MICROSOFT_RETURNS: Readonly<Record<string, { tone: 'brand' | 'danger'; text: string }>> = {
  connected: { tone: 'brand', text: 'Microsoft とつながりました。これからの PDF は Office が作ります。' },
  failed: { tone: 'danger', text: 'Microsoft とつなげませんでした。もう一度つないでください。' },
};

/** What an MCP Server's sign-in screen sent the administrator back to say; a failure's reason is on the server's row. */
const MCP_RETURNS: Readonly<Record<string, { tone: 'brand' | 'danger'; text: string }>> = {
  connected: { tone: 'brand', text: '外部ツールにサインインしました。自動化とチャットが、そのツールを使えます。' },
  failed: { tone: 'danger', text: '外部ツールにサインインできませんでした。理由は外部ツール（MCP）の一覧に出ています。' },
};

/**
 * The credentials the whole Account shares and no single Automation owns, and what it
 * lends to outside agents and tools. Each credential is
 * checked where it is entered.
 */
/** What a grant given before drafts, the Drive, Meet, or Google Tasks were reached still lacks, and what waits on reconnecting it. */
const missingGrants = (automation: AutomationStatus): string => {
  const missing = [
    ...(automation.draftsGranted ? [] : [{ grant: 'Gmail に下書きを保存する許可', effect: 'メールを送らずに下書きだけ作ること' }]),
    ...(automation.driveGranted ? [] : [{ grant: 'Drive を読み書きする許可', effect: 'AI が Drive のファイルを探したり、読んだり、整理したりすること' }]),
    ...(automation.meetGranted ? [] : [{ grant: 'Google Meet の会議を読む許可', effect: 'AI が会議の文字起こしを読んで議事録にしたり、会議の自動文字起こしをオンにしたりすること' }]),
    ...(automation.tasksGranted ? [] : [{ grant: 'Google ToDo を読み書きする許可', effect: 'AI がタスクを Google ToDo で調べたり、登録したり、完了にしたりすること（これまでのタスクを Google ToDo へ移すことも、つなぎ直したあとに始まります）' }]),
  ];
  return `${missing.map((item) => item.grant).join('と、')}がまだありません。つなぎ直すまで、${missing.map((item) => item.effect).join('や、')}はできません。`;
};

const ConnectionsScreen = () => {
  const data = useLoaderData<ConnectionsData>();
  const { account, reauthenticate, reauthenticating } = useAccount();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  // The chat's model menu opens this screen at the AI Connection's sheet (`?sheet=ai`).
  const [sheet, setSheet] = useState<Sheets>(() => searchParams.get('sheet') === 'ai' ? 'ai' : null);
  const microsoftReturn = MICROSOFT_RETURNS[searchParams.get('microsoft') ?? ''];
  const mcpReturn = MCP_RETURNS[searchParams.get('mcp') ?? ''];
  const close = (): void => setSheet(null);
  const reload = (): Promise<void> => revalidator.revalidate();
  return <Page title="接続" back={{ to: '../more', label: 'その他' }} narrow>
    <Deferred value={data.shared} fallback={<SkeletonRows count={4} />}>{({ connections, automation }) => {
      const inbox = automation ? named(inboxStatus, automation.status) : null;
      const lineReady = connections.line.channelAccessTokenConfigured && connections.line.channelSecretConfigured;
      return <Section title="サービス">
        {automation?.status === 'reauthentication_required' && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />} action={<GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />}>
          Google の認証が切れました。つなぎ直すまで、メールを読めません。
        </Banner>}
        {microsoftReturn && <Banner tone={microsoftReturn.tone} icon={microsoftReturn.tone === 'danger' ? <CircleAlert size={18} aria-hidden="true" /> : undefined}>{microsoftReturn.text}</Banner>}
        {automation?.status === 'active' && (!automation.draftsGranted || !automation.driveGranted || !automation.meetGranted || !automation.tasksGranted) && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />} action={<GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />}>
          {missingGrants(automation)}
        </Banner>}
        <List>
          <Row
            {...(automation ? {} : { onClick: reauthenticate })}
            leading={<Mail size={20} aria-hidden="true" />}
            title="Google（メールの受信箱）"
            sub={automation ? `${automation.email} ・ Gmail・カレンダー・Drive・Meet`
              : reauthenticating ? 'Google へ移動しています…'
              : 'つなぐと、AI がメール・カレンダー・Drive・Meet を使えます'}
            aside={inbox ? <Chip tone={inbox.tone}>{inbox.label}</Chip> : <Chip tone="neutral">未接続</Chip>}
          />
          <Row
            onClick={() => setSheet('ai')}
            leading={<Bot size={20} aria-hidden="true" />}
            title="AI"
            sub={aiSummary(connections)}
            wrap
            aside={connections.ai.apiKeyConfigured ? <Chip tone="brand">接続中</Chip> : <Chip tone="danger">未設定</Chip>}
          />
          <Row
            onClick={() => setSheet('line')}
            leading={<MessageCircle size={20} aria-hidden="true" />}
            title="LINE"
            sub={lineReady ? 'Messaging API' : connections.line.channelAccessTokenConfigured || connections.line.channelSecretConfigured ? '片方だけ入力されています' : '使う場合だけ設定します'}
            aside={lineReady ? <Chip tone="brand">接続中</Chip> : <Chip tone="neutral">未設定</Chip>}
          />
          <Row
            onClick={() => setSheet('microsoft')}
            leading={<FileText size={20} aria-hidden="true" />}
            title="Microsoft"
            sub={!connections.microsoft.connected ? 'つなぐと、PDF を Word と同じ見た目で作ります'
              : connections.microsoft.email ? `${connections.microsoft.email} ・ PDF を Word と同じ見た目で作ります`
              : 'PDF を Word と同じ見た目で作ります'}
            aside={connections.microsoft.connected ? <Chip tone="brand">接続中</Chip> : <Chip tone="neutral">未設定</Chip>}
          />
          <Row
            onClick={() => setSheet('discord')}
            leading={<MessagesSquare size={20} aria-hidden="true" />}
            title="Discord"
            sub="使う場合だけ設定します"
          />
        </List>
        {sheet === 'ai' && <AiSheet connections={connections} onClose={close} />}
        {sheet === 'line' && <LineSheet connections={connections} onClose={close} />}
        {sheet === 'microsoft' && <MicrosoftSheet connections={connections} onClose={close} />}
      </Section>;
    }}</Deferred>
    <Deferred value={data.lent} fallback={<SkeletonRows />}>{({ contactLists, accessTokens, mcpServers, operatorTokens, endpoint }) => <>
      {mcpReturn && <Banner tone={mcpReturn.tone} icon={mcpReturn.tone === 'danger' ? <CircleAlert size={18} aria-hidden="true" /> : undefined}>{mcpReturn.text}</Banner>}
      <McpServers accountId={account.accountId} servers={mcpServers} reload={reload} />
      <AccessTokens accountId={account.accountId} lists={contactLists} tokens={accessTokens} reload={reload} />
      <OperatorTokens accountId={account.accountId} tokens={operatorTokens} endpoint={endpoint.url} reload={reload} />
    </>}</Deferred>
    {sheet === 'discord' && <DiscordSheet accountId={account.accountId} onClose={close} />}
  </Page>;
};

export default ConnectionsScreen;
