/**
 * The model every run thinks through, called with Pi's pi-ai (ADR 0203):
 * Claude on Anthropic's Messages API, GPT on OpenAI's Responses API, Gemini on
 * its own generateContent, and any other Base URL, OpenRouter's among them, on
 * Chat Completions. OrangeAgent keeps no adapter of its own for any provider.
 *
 * A run's messages are OrangeAgent's own (`TurnMessage`), so a conversation
 * kept before Pi still reads; they become Pi's messages here, for one request,
 * and the answer comes back as one again, carrying Pi's own record of it as
 * its replay so the next request sends it exactly as the provider wrote it.
 */

import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ThinkingLevel, Tool, ToolCall } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { ProviderStreams } from '@earendil-works/pi-ai';
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
// Gemini's API is loaded the first time a run calls it, as Pi's own lazy module loads it: its SDK alone is over a megabyte.
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { aiEnvironment, aiProviderOf, type ModelEffort } from '@mail/domain';

import { toBase64 } from './encoding';
import { EffortRefused, effortFor, openRouterContext, refusesEffort } from './effort';
import type { ModelUsage } from './usage';
import type { ModelCompletion, ModelConnection, ModelRequest, PiReplay, TurnEvent, TurnFile, TurnMessage } from './turns';

/** Tool names a provider accepts; the product's are namespaced with a dot, as `mail.search`. */
const NAME_LIMIT = 64;
const INVALID_NAME = /[^A-Za-z0-9_-]/gu;

/**
 * A reversible mapping from the product's tool names to names every provider
 * accepts, derived from the tool list alone, so every request of one run sends
 * the same names: `mail.search` goes as `mail_search`.
 */
export const wireNames = (names: readonly string[]): { wire: (name: string) => string; original: (name: string) => string } => {
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  const assign = (name: string): string => {
    const known = forward.get(name);
    if (known) return known;
    const base = name.replace(INVALID_NAME, '_').slice(0, NAME_LIMIT) || 'tool';
    let candidate = base;
    for (let suffix = 2; backward.has(candidate); suffix += 1) {
      const tail = `_${suffix}`;
      candidate = `${base.slice(0, NAME_LIMIT - tail.length)}${tail}`;
    }
    forward.set(name, candidate);
    backward.set(candidate, name);
    return candidate;
  };
  names.forEach(assign);
  return { wire: assign, original: (name) => backward.get(name) ?? name };
};

type Stream = ProviderStreams['streamSimple'];

/** Which of pi-ai's APIs a Base URL is spoken in, and the catalog its models are described in. */
interface Protocol {
  api: Api;
  provider: string;
  baseUrl: string;
  stream: Stream;
  catalog: Readonly<Record<string, Model<Api>>>;
}

const protocolOf = (baseUrl: string): Protocol => {
  const origin = new URL(baseUrl).origin;
  switch (aiEnvironment(baseUrl)) {
    case 'anthropic':
      return { api: 'anthropic-messages', provider: 'anthropic', baseUrl: origin, stream: anthropicStream as Stream, catalog: ANTHROPIC_MODELS };
    case 'openai':
      return { api: 'openai-responses', provider: 'openai', baseUrl: `${origin}/v1`, stream: responsesStream as Stream, catalog: OPENAI_MODELS };
    case 'gemini':
      // The legacy OpenAI-compatible URL is read as Gemini's own API, as it was before Pi.
      return { api: 'google-generative-ai', provider: 'google', baseUrl: `${origin}/v1beta`, stream: (model, context, options) => googleGenerativeAIApi().streamSimple(model, context, options), catalog: GOOGLE_MODELS };
    case 'orangeagent': {
      const openRouter = aiProviderOf(baseUrl) === 'openrouter';
      return {
        api: 'openai-completions',
        provider: openRouter ? 'openrouter' : 'openai-compatible',
        baseUrl: baseUrl.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, ''),
        stream: completionsStream as Stream,
        // OpenRouter's own model list says which of its models reason and how much each reads (effort.ts), so Pi's 300 KB catalog of it is not loaded.
        catalog: {},
      };
    }
  }
};

/** A model Pi's catalog does not know is described as a model that reads text and images and writes as much as most do. */
const FALLBACK_CONTEXT = 200_000;
const FALLBACK_MAX_TOKENS = 32_000;

/** The connection's model as Pi describes it: from its catalog when it knows the model, else as any model of that API. */
export const piModel = (connection: Pick<ModelConnection, 'baseUrl' | 'model'>): { model: Model<Api>; stream: Stream } => {
  const protocol = protocolOf(connection.baseUrl);
  const id = connection.model.trim().replace(/^models\//u, '');
  const known = protocol.catalog[id];
  const model: Model<Api> = known
    ? { ...known, baseUrl: protocol.baseUrl, provider: protocol.provider }
    : {
      id, name: id, api: protocol.api, provider: protocol.provider, baseUrl: protocol.baseUrl,
      input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false, contextWindow: FALLBACK_CONTEXT, maxTokens: FALLBACK_MAX_TOKENS,
    };
  return { model, stream: protocol.stream };
};

/** Pi's level of thinking for the product's level of effort. */
const THINKING: Readonly<Record<ModelEffort, ThinkingLevel | undefined>> = {
  none: undefined, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/u;

/**
 * A file as the model is handed it: a picture as itself, text as its words,
 * and any other kind as a note that the run holds it, which its code opens
 * with code.run (ADR 0203); without code.run, as a note that it cannot be
 * opened here. The note is OrangeAgent's, in its brackets: unbracketed, it
 * ends a member's message as an order in English, and Haiku answers that
 * order in English rather than the member in their own language.
 */
const fileContent = (file: TurnFile, code: boolean): TextContent | ImageContent => {
  if (file.mediaType.startsWith('image/')) return { type: 'image', data: toBase64(file.bytes), mimeType: file.mediaType };
  if (TEXT_TYPES.test(file.mediaType)) return { type: 'text', text: `${file.filename}:\n${new TextDecoder().decode(file.bytes)}` };
  if (code) return { type: 'text', text: `[OrangeAgent: you hold ${file.filename} (${file.mediaType || 'unknown type'}). Open it with code.run, naming ${file.filename} in files, rather than guessing its contents.]` };
  return { type: 'text', text: `[OrangeAgent: ${file.filename} (${file.mediaType || 'unknown type'}) cannot be opened here, because this Worker lends no environment to run code in. Say so rather than guessing its contents.]` };
};

/** Whether a tool's answer is a refusal, as `{ isError: true }`. */
const refused = (content: string): boolean => {
  try {
    const value = JSON.parse(content) as { isError?: unknown };
    return typeof value === 'object' && value !== null && value.isError === true;
  } catch {
    return false;
  }
};

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const parsedArguments = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text || '{}') as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** Pi's record of an assistant turn this product kept, or null for one kept before Pi. */
const piReplay = (message: TurnMessage): PiReplay | null =>
  message.replay && 'kind' in message.replay && message.replay.kind === 'pi' ? message.replay : null;

/**
 * The run's messages as Pi's, for one request. An assistant turn Pi wrote is
 * sent as Pi kept it; one kept before Pi, as its words and its calls.
 */
export const piMessages = (messages: readonly TurnMessage[], wire: (name: string) => string, code: boolean): { systemPrompt: string; messages: Message[] } => {
  const system: string[] = [];
  const converted: Message[] = [];
  const timestamp = Date.now();
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      const files = (message.attachments ?? []).map((file) => fileContent(file, code));
      converted.push({ role: 'user', content: [...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...files], timestamp });
      continue;
    }
    if (message.role === 'assistant') {
      const kept = piReplay(message);
      if (kept) {
        converted.push({
          ...kept.message,
          content: kept.message.content.map((part) => part.type === 'toolCall' ? { ...part, name: wire(part.name) } : part),
        });
        continue;
      }
      const calls: ToolCall[] = (message.toolCalls ?? []).map((call) => ({ type: 'toolCall', id: call.id, name: wire(call.name), arguments: parsedArguments(call.arguments) as ToolCall['arguments'] }));
      converted.push({
        role: 'assistant',
        content: [...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...calls],
        // Another provider's turn: Pi sends its words and calls, never its signatures.
        api: 'orangeagent', provider: 'orangeagent', model: 'orangeagent',
        usage: ZERO_USAGE, stopReason: calls.length ? 'toolUse' : 'stop', timestamp,
      });
      continue;
    }
    const files = (message.attachments ?? []).map((file) => fileContent(file, code));
    converted.push({
      role: 'toolResult',
      toolCallId: message.toolCallId ?? '',
      toolName: wire(message.name ?? ''),
      content: [{ type: 'text', text: message.content }, ...files],
      isError: refused(message.content),
      timestamp,
    });
  }
  return { systemPrompt: system.join('\n\n'), messages: converted };
};

/** Whether Pi knows any price of the model, so that its cost of zero would mean free rather than unknown. */
const priced = (model: Model<Api>): boolean =>
  [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((rate) => rate > 0);

/**
 * What one request consumed, every prompt token counted, cache hits and writes
 * among them, and what it cost where the provider billed it or Pi's catalog
 * prices the model.
 */
const usageFrom = (usage: AssistantMessage['usage'], model: Model<Api>): ModelUsage => {
  const billed = usage.cost.totalFromProvider === true;
  const known = (billed || priced(model)) && Number.isFinite(usage.cost.total) && usage.cost.total >= 0;
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    cachedTokens: usage.cacheRead,
    completionTokens: usage.output,
    ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(known ? { costUsd: usage.cost.total, costBilled: billed } : {}),
  };
};

/** The request's level of effort as Pi's, when its model takes it. */
const thinkingFor = async (request: ModelRequest): Promise<ThinkingLevel | undefined> => {
  const effort = await effortFor(request, request.effort);
  return effort ? THINKING[effort] : undefined;
};

/** How much the conversation now holds, and the most its model reads in one request. */
const contextOf = async (request: ModelRequest, model: Model<Api>, usage: ModelUsage): Promise<{ tokens: number; max: number | null }> => {
  const listed = model.provider === 'openrouter' ? await openRouterContext(request) : null;
  return { tokens: usage.promptTokens + usage.completionTokens, max: listed ?? (model.contextWindow || null) };
};

/**
 * One request to the model. Given `onEvent`, its words and its reasoning are
 * handed over as they are written. A level of effort the provider refuses is
 * thrown as `EffortRefused`, so the caller can ask again without one.
 */
export const completeTurn = async (request: ModelRequest, onEvent?: (event: TurnEvent) => void): Promise<ModelCompletion> => {
  const { model, stream } = piModel(request);
  const names = wireNames(request.tools.map((tool) => tool.function.name));
  const code = request.tools.some((tool) => tool.function.name === 'code.run');
  const converted = piMessages(request.messages, names.wire, code);
  const tools: Tool[] = request.tools.map((tool) => ({ name: names.wire(tool.function.name), description: tool.function.description, parameters: tool.function.parameters }));
  const reasoning = await thinkingFor(request);
  // A model Pi's catalog does not know is still sent the level OrangeAgent found it takes, as an OpenRouter model's list says.
  const thinking = reasoning && !model.reasoning ? { ...model, reasoning: true } : model;
  const events = stream(thinking, normalizeContext({ systemPrompt: converted.systemPrompt, messages: converted.messages, tools }), {
    apiKey: request.apiKey,
    // The instructions and tools are the same from one conversation to the next, so they are cached for an hour rather than Pi's five minutes:
    // a member's first message after a pause is read from the cache instead of paying for the whole prompt again.
    cacheRetention: 'long',
    ...(reasoning ? { reasoning } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  for await (const event of events) {
    if (event.type === 'text_delta') onEvent?.({ type: 'text', text: event.delta });
    else if (event.type === 'thinking_delta') onEvent?.({ type: 'reasoning', text: event.delta });
  }
  const answered = await events.result();
  if (answered.stopReason === 'aborted') throw new Error('The answer was stopped.');
  if (answered.stopReason === 'error') {
    const message = answered.errorMessage?.trim() || 'The model could not be called.';
    if (reasoning && refusesEffort(400, message)) throw new EffortRefused(message);
    throw new Error(message);
  }
  if (answered.stopReason === 'length') throw new Error(`${model.name}: 応答が出力の上限で打ち切られました。`);
  // Pi's record keeps the product's names, so a later request wires them again for whatever tools it holds.
  const message: AssistantMessage = {
    ...answered,
    content: answered.content.map((part) => part.type === 'toolCall' ? { ...part, name: names.original(part.name) } : part),
  };
  const usage = usageFrom(message.usage, model);
  return {
    model: message.responseModel ?? message.model ?? request.model,
    content: message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
    toolCalls: message.content.flatMap((part) => part.type === 'toolCall'
      ? [{ id: part.id, name: part.name, arguments: part.argumentsError ? '' : JSON.stringify(part.arguments ?? {}) }]
      : []),
    usage,
    context: await contextOf(request, model, usage),
    replay: { kind: 'pi', message },
  };
};

/** Asks the model one question with no tools and reads its answer's words, as a connection check or a summary does. */
export const askModel = async (connection: ModelConnection, prompt: string): Promise<{ model: string; text: string; usage: ModelUsage }> => {
  const completion = await completeTurn({ ...connection, messages: [{ role: 'user', content: prompt }], tools: [] });
  return { model: completion.model, text: completion.content, usage: completion.usage };
};
