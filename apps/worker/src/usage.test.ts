import { describe, expect, it } from 'vitest';

import { usageOf } from './usage';

describe('model usage', () => {
  it('reads the prompt-cache hits an OpenAI-compatible provider reports', () => {
    expect(usageOf({ prompt_tokens: 900, completion_tokens: 50, total_tokens: 950, prompt_tokens_details: { cached_tokens: 800 } }))
      .toEqual({ promptTokens: 900, cachedTokens: 800, completionTokens: 50 });
  });

  it('reads the cache hits DeepSeek reports under its own name', () => {
    expect(usageOf({ prompt_tokens: 900, completion_tokens: 50, prompt_cache_hit_tokens: 640 }))
      .toEqual({ promptTokens: 900, cachedTokens: 640, completionTokens: 50 });
  });

  it('counts a provider that reports only a total as having cached nothing', () => {
    expect(usageOf({ total_tokens: 700 })).toEqual({ promptTokens: 700, cachedTokens: 0, completionTokens: 0 });
  });

  it('never counts more cache hits than the prompt held', () => {
    expect(usageOf({ prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 500 } }).cachedTokens).toBe(100);
  });
});
