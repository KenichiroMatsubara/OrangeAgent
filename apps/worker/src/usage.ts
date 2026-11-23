/**
 * What a model-driven run consumed, as the providers report it. A run records
 * every token it processed; no count of tokens bounds it. The provider's own
 * context window is the only limit on one request, which it enforces by
 * refusing a request too large for it before running it.
 */

/** What one OpenAI-compatible completion reports it consumed. */
export interface ModelUsage {
  promptTokens: number;
  /** The part of `promptTokens` the provider served from its prompt cache. */
  cachedTokens: number;
  /** Includes reasoning tokens, which providers bill as output. */
  completionTokens: number;
  /** The part of `promptTokens` written to the prompt cache, where the provider reports it apart: Anthropic does, at a higher price than an uncached token. */
  cacheWriteTokens?: number;
  /** What the request cost in US dollars: the provider's bill where it reports one (OpenRouter), else Pi's catalog price. Absent when neither is known. */
  costUsd?: number;
  /** Whether `costUsd` is the provider's bill rather than an estimate from list prices. */
  costBilled?: boolean;
}

/** The `usage` block of an OpenAI-compatible response, as the providers in use report it. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek reports its cache hits here instead of in `prompt_tokens_details`. */
  prompt_cache_hit_tokens?: number;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Reads a response's usage. A provider that reports no cache hits is counted as having cached nothing. */
export const usageOf = (usage: WireUsage | undefined): ModelUsage => {
  const completionTokens = count(usage?.completion_tokens);
  const promptTokens = usage?.prompt_tokens === undefined
    ? Math.max(0, count(usage?.total_tokens) - completionTokens)
    : count(usage.prompt_tokens);
  const cached = Math.max(count(usage?.prompt_tokens_details?.cached_tokens), count(usage?.prompt_cache_hit_tokens));
  return { promptTokens, cachedTokens: Math.min(promptTokens, cached), completionTokens };
};

/** Every token one turn processed, cache hits included. */
export const totalTokens = (usage: ModelUsage): number => usage.promptTokens + usage.completionTokens;
