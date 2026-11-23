/**
 * Where an AI Connection's model runs code (ADR 0202), read from its Base
 * URL's host as its protocol is, so the Worker and the Connections screen
 * agree without storing it: Anthropic's sandbox, OpenAI's code interpreter,
 * Gemini's code execution, or, for every other API, one OrangeAgent lends.
 */
export type AiEnvironment = 'anthropic' | 'openai' | 'gemini' | 'orangeagent';

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const OPENAI_HOST = 'api.openai.com';
export const GEMINI_HOST = 'generativelanguage.googleapis.com';

export const aiEnvironment = (baseUrl: string): AiEnvironment => {
  let host = '';
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return 'orangeagent';
  }
  if (host === ANTHROPIC_HOST) return 'anthropic';
  if (host === OPENAI_HOST) return 'openai';
  if (host === GEMINI_HOST) return 'gemini';
  return 'orangeagent';
};

/**
 * The APIs an AI Connection may be made on: Claude, OpenAI, and Gemini, whose
 * models run code in their own environments, and OpenRouter, whose models run
 * it in the one OrangeAgent lends. The administrator chooses one and saves its
 * key; the Base URL is the provider's own, never typed.
 */
export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter';

export const AI_PROVIDERS: readonly AiProvider[] = ['anthropic', 'openai', 'gemini', 'openrouter'];

export const OPENROUTER_HOST = 'openrouter.ai';

/** The Base URL each provider is called at. */
export const AI_BASE_URLS: Readonly<Record<AiProvider, string>> = {
  anthropic: `https://${ANTHROPIC_HOST}/v1`,
  openai: `https://${OPENAI_HOST}/v1`,
  gemini: `https://${GEMINI_HOST}/v1beta`,
  openrouter: `https://${OPENROUTER_HOST}/api/v1`,
};

/**
 * The provider a saved Base URL is on, read from its host, or null for a
 * Connection saved on another API before the four were the only ones, which
 * goes on answering until it is saved again on one of them.
 */
export const aiProviderOf = (baseUrl: string): AiProvider | null => {
  let host = '';
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === ANTHROPIC_HOST) return 'anthropic';
  if (host === OPENAI_HOST) return 'openai';
  if (host === GEMINI_HOST) return 'gemini';
  if (host === OPENROUTER_HOST) return 'openrouter';
  return null;
};

export const isAiProvider = (value: unknown): value is AiProvider =>
  AI_PROVIDERS.some((provider) => provider === value);
