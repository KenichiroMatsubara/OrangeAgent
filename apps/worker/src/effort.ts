/**
 * How hard a model thinks: the levels each model of an AI Connection takes,
 * and how a level chosen for a message reaches the model's own API.
 *
 * Claude's levels are those Pi's model catalog (`@earendil-works/pi-ai`)
 * gives its model; an OpenRouter model's are read from whether OpenRouter's
 * Models API lists `reasoning` among its parameters.
 * OpenAI's and Gemini's APIs say nothing of it, so their models' levels come
 * from the table below, by model family, as each provider documents them; a
 * model the table does not know takes no choice, or, in a family that thinks,
 * the levels every model of it takes. A provider that still refuses a level is
 * caught (EffortRefused) and the answer goes on at the model's default.
 */

import { aiProviderOf, type ModelEffort, type ModelEfforts } from '@mail/domain';

import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';

const CLAUDE_LEVELS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The levels Pi's catalog says a Claude model takes, the lightest first; none for a model it does not know or that does not think. */
const claudeEfforts = (model: string): ModelEffort[] => {
  const catalog: Readonly<Record<string, Model<Api>>> = ANTHROPIC_MODELS;
  const known = catalog[model.trim()];
  if (!known?.reasoning) return [];
  const supported = new Set<string>(getSupportedThinkingLevels(known));
  return CLAUDE_LEVELS.filter((level) => supported.has(level));
};

interface Connection {
  apiKey: string;
  baseUrl: string;
  model: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The model as Gemini names it, whether saved as `models/gemini-3-flash` or not. */
const geminiName = (model: string): string => model.trim().replace(/^models\//u, '').toLowerCase();

/** A provider refused the level of effort a request named; the request is asked again without it. */
export class EffortRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffortRefused';
  }
}

const efforts = (levels: ModelEffort[], fallback: ModelEffort | null = null): ModelEfforts => ({ levels, default: fallback });

/**
 * An OpenAI model's levels, by family: o-series reasoning models take low to
 * high at medium; gpt-5, gpt-5-mini, and gpt-5-nano minimal to high at
 * medium; gpt-5.1 none to high at none; gpt-5.2 and later none to xhigh at
 * none; the Codex models low to high. A later family takes low to high, which
 * every OpenAI reasoning model takes, its default unknown. GPT-4 and earlier,
 * the chat models, and the pro models (which take few levels, differently per
 * model) take no choice.
 */
export const openAiEfforts = (model: string): ModelEfforts | null => {
  const name = model.trim().toLowerCase();
  if (/^(gpt-[34]|chatgpt)/u.test(name) || /(^|-)chat(-|$)/u.test(name) || /(^|-)pro(-|$)/u.test(name)) return null;
  if (/^o\d/u.test(name)) return efforts(['low', 'medium', 'high'], 'medium');
  if (/codex/u.test(name)) return efforts(['low', 'medium', 'high'], 'medium');
  if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/u.test(name)) return efforts(['minimal', 'low', 'medium', 'high'], 'medium');
  if (/^gpt-5\.1(-|$)/u.test(name)) return efforts(['none', 'low', 'medium', 'high'], 'none');
  if (/^gpt-5\.\d/u.test(name)) return efforts(['none', 'low', 'medium', 'high', 'xhigh'], 'none');
  if (/^gpt-\d/u.test(name)) return efforts(['low', 'medium', 'high']);
  return null;
};

/**
 * A Gemini model's levels, by family: Gemini 3 Pro takes low and high, a
 * later Gemini 3 Pro low to high, Gemini 3 Flash minimal to high, each at
 * high; Gemini 2.5 thinks by a budget of tokens, so its levels stand for
 * budgets (geminiThinking), Flash's from none, Pro's from low, as Pro cannot
 * stop thinking, at its own dynamic budget. A later Gemini takes low and high,
 * which every Gemini 3 takes, its default unknown. Gemini 2.0 and earlier do
 * not think.
 */
export const geminiEfforts = (model: string): ModelEfforts | null => {
  const name = geminiName(model);
  if (/^gemini-2\.5-pro/u.test(name)) return efforts(['low', 'medium', 'high']);
  if (/^gemini-2\.5-flash/u.test(name)) return efforts(['none', 'low', 'medium', 'high']);
  if (/^gemini-3-pro/u.test(name)) return efforts(['low', 'high'], 'high');
  if (/^gemini-3(\.\d+)?-pro/u.test(name)) return efforts(['low', 'medium', 'high'], 'high');
  if (/^gemini-3(\.\d+)?-flash/u.test(name)) return efforts(['minimal', 'low', 'medium', 'high'], 'high');
  const major = /^gemini-(\d+)/u.exec(name)?.[1];
  if (major && Number(major) >= 3) return efforts(['low', 'high']);
  return null;
};

/** The tokens Gemini 2.5 thinks with at each level; Pro thinks with at most 32,768, Flash 24,576. */
const GEMINI_BUDGETS: Readonly<Partial<Record<ModelEffort, number>>> = { none: 0, low: 1_024, medium: 8_192 };

/** What `generationConfig.thinkingConfig` says for a level: Gemini 2.5's budget, or a later Gemini's level. */
export const geminiThinking = (model: string, effort: ModelEffort): Record<string, unknown> => {
  const name = geminiName(model);
  if (!name.startsWith('gemini-2.5')) return { thinkingLevel: effort };
  const top = name.startsWith('gemini-2.5-pro') ? 32_768 : 24_576;
  return { thinkingBudget: effort === 'high' ? top : GEMINI_BUDGETS[effort] ?? top };
};

/** How long OpenRouter's model list is kept: it is read once an hour while the Worker runs. */
const OPENROUTER_TTL_MS = 60 * 60 * 1_000;
/** What OpenRouter's model list says of its models: those that reason, and how much each reads in one request. */
interface OpenRouterModels {
  reasoning: ReadonlySet<string>;
  contexts: ReadonlyMap<string, number>;
}

let openRouterRead: { at: number; models: Promise<OpenRouterModels> } | null = null;

const openRouterModels = (connection: Connection, fetcher: Fetch): Promise<OpenRouterModels> => {
  if (openRouterRead && Date.now() - openRouterRead.at < OPENROUTER_TTL_MS) return openRouterRead.models;
  const models = fetcher(`${connection.baseUrl.replace(/\/+$/u, '')}/models`, { headers: { Authorization: `Bearer ${connection.apiKey}` } })
    .then(async (response): Promise<OpenRouterModels> => {
      if (!response.ok) throw new Error(`OpenRouter models: HTTP ${response.status}`);
      const body = await response.json() as { data?: Array<{ id?: unknown; supported_parameters?: unknown; context_length?: unknown }> };
      const listed = body.data ?? [];
      return {
        reasoning: new Set(listed.flatMap((model) =>
          typeof model.id === 'string' && Array.isArray(model.supported_parameters) && model.supported_parameters.includes('reasoning') ? [model.id] : [])),
        contexts: new Map(listed.flatMap((model): Array<[string, number]> =>
          typeof model.id === 'string' && typeof model.context_length === 'number' && model.context_length > 0 ? [[model.id, model.context_length]] : [])),
      };
    })
    .catch((): OpenRouterModels => {
      // Read again next time rather than leaving one failed read in place.
      openRouterRead = null;
      return { reasoning: new Set(), contexts: new Map() };
    });
  openRouterRead = { at: Date.now(), models };
  return models;
};

/** Forgets OpenRouter's model list, as a new Worker starts; tests start each case so. */
export const forgetOpenRouterModels = (): void => {
  openRouterRead = null;
};

const openRouterReasoning = async (connection: Connection, fetcher: Fetch): Promise<ReadonlySet<string>> => (await openRouterModels(connection, fetcher)).reasoning;

/** How much an OpenRouter model reads in one request, as its model list says, or null. */
export const openRouterContext = async (connection: Connection, fetcher: Fetch = (url, init) => fetch(url, init)): Promise<number | null> =>
  (await openRouterModels(connection, fetcher)).contexts.get(connection.model.trim()) ?? null;

/**
 * The levels of effort a Connection's model takes, or null when it takes no
 * choice. Claude's default is high; an OpenRouter model takes low to high,
 * which OpenRouter maps onto every model that reasons, its default unknown.
 */
export const modelEfforts = async (connection: Connection, fetcher: Fetch = (url, init) => fetch(url, init)): Promise<ModelEfforts | null> => {
  const provider = aiProviderOf(connection.baseUrl);
  if (provider === 'anthropic') {
    const levels = claudeEfforts(connection.model);
    return levels.length ? efforts(levels, levels.includes('high') ? 'high' : null) : null;
  }
  if (provider === 'openai') return openAiEfforts(connection.model);
  if (provider === 'gemini') return geminiEfforts(connection.model);
  if (provider === 'openrouter') return (await openRouterReasoning(connection, fetcher)).has(connection.model.trim()) ? efforts(['low', 'medium', 'high']) : null;
  return null;
};

/** The level a request is sent: the one asked for when the model takes it, else none, and the model thinks at its default. */
export const effortFor = async (connection: Connection, asked: ModelEffort | undefined): Promise<ModelEffort | undefined> => {
  if (!asked) return undefined;
  const taken = await modelEfforts(connection);
  return taken?.levels.includes(asked) ? asked : undefined;
};

/** Whether a 400 a provider answered is about the level of effort sent, read from its error's words or the parameter it names. */
export const refusesEffort = (status: number, message: string, param?: string | null): boolean =>
  status === 400 && (/reasoning|effort|thinking/iu.test(param ?? '') || /reasoning|effort|thinking/iu.test(message));
