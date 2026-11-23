import { and, eq } from 'drizzle-orm';

import { decrypt } from './cryptography';
import { conflict, invalid } from './refusal';
import { accountKeyFor } from './keys';
import { accountDatabase } from './storage/database';
import { connections } from './storage/account-schema';
import type { Bindings } from './types';

/** The OpenAI-compatible endpoint the product used before an Account could choose its own. */
export const LEGACY_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export interface AiConnection {
  apiKey: string;
  baseUrl: string;
  /** The model this call is answered by: the default, unless a run chose another of `models`. */
  model: string;
  /** Every model the Connection names, the default first; a run may be answered by any of them and no other. */
  models: string[];
}

interface AiCredential {
  apiKey?: string;
  /** The default model. */
  model?: string;
  /** Every model the administrator named, one per line, the default first; a Connection saved before there were several has none. */
  models?: string;
  baseUrl?: string;
}

/** The longest list of models one AI Connection names, kept with the GUI that lists them. */
export { AI_MODEL_LIMIT } from '@mail/domain';

/**
 * Every model a credential names, the default first and each once. A
 * credential saved before an Account could name several names its default alone.
 */
export const aiModels = (credential: { model?: string; models?: string }): string[] => {
  // Kept one per line, because a Connection's credential holds only strings.
  const named = typeof credential.models === 'string' ? credential.models.split('\n') : [];
  const all = [credential.model ?? '', ...named].map((model) => model.trim()).filter(Boolean);
  return [...new Set(all)];
};

/** The Connection answered by `model`, refused when the Connection does not name it; left out, its default. */
export const withModel = (connection: AiConnection, model: string | null | undefined): AiConnection => {
  const chosen = model?.trim();
  if (!chosen || chosen === connection.model) return connection;
  if (!connection.models.includes(chosen)) throw invalid(`モデル ${chosen} は AI 接続に登録されていません。設定の「接続」で登録したモデルだけを選べます。`);
  return { ...connection, model: chosen };
};

/**
 * The Account's AI Connection as the model provider needs it, or null when none
 * is configured. Reading it is the one place the credential is decrypted, so
 * every caller that thinks with a model agrees on what "configured" means.
 */
export const aiConnection = async (env: Bindings, accountId: string, database: D1Database): Promise<AiConnection | null> => {
  const connection = await accountDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) return null;
  const key = await accountKeyFor(env, accountId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${accountId}:ai`)) as AiCredential;
  const models = aiModels(credential);
  const model = models[0];
  if (!credential.apiKey || !model) return null;
  return { apiKey: credential.apiKey, baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL, model, models };
};

/** The AI Connection, or the refusal an operator reads when there is none. */
export const requiredAiConnection = async (env: Bindings, accountId: string, database: D1Database): Promise<AiConnection> => {
  const connection = await aiConnection(env, accountId, database);
  if (!connection) throw conflict('先に AI 接続を設定してください。');
  return connection;
};

export const openAiChatCompletionsUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/u, '')}/chat/completions`;

/** A safe, canonical OpenAI-compatible Base URL, or null when the value is not one. */
export const normalizedAiBaseUrl = (value: string | undefined): string | null => {
  try {
    const url = new URL(value?.trim() ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return null;
  }
};
