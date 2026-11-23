import { beforeEach, describe, expect, it } from "vitest";

import type { OrchestrationV2RunUsage } from "@t3tools/contracts";
import { DEFAULT_LOCALE } from "~/i18n/locales";
import { m, setActiveLocale } from "~/i18n/messages";
import {
  cacheSharePercent,
  chatCost,
  formatChatCost,
  formatCostUsd,
  formatRunCost,
  contextSharePercent,
  earlierConversationCacheSharePercent,
  formatCacheShares,
  formatContextUsage,
  formatRunUsageSummary,
  latestRunUsage,
  sharePercent,
} from "./runUsage";

const usage = (fields: Partial<OrchestrationV2RunUsage> = {}): OrchestrationV2RunUsage => ({
  requests: 4,
  inputTokens: 12_300,
  cachedInputTokens: 10_455,
  cacheWriteTokens: 900,
  outputTokens: 1_200,
  firstInputTokens: 9_000,
  firstCachedInputTokens: 6_300,
  contextTokens: 14_000,
  maxContextTokens: 200_000,
  ...fields,
});

describe("what an answer and a chat cost", () => {
  beforeEach(() => setActiveLocale(DEFAULT_LOCALE));

  it("reads a dollar cost as short as it reads, and a fraction of a cent as more than nothing", () => {
    expect(formatCostUsd(0)).toBe("$0");
    expect(formatCostUsd(0.00004)).toBe("<$0.0001");
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
    expect(formatCostUsd(0.01234)).toBe("$0.012");
    expect(formatCostUsd(1.5)).toBe("$1.50");
  });

  it("adds the cost to the answer's summary only where it is known, and says whether it is a bill", () => {
    expect(formatRunUsageSummary(usage({ costUsd: 0.0123 }), m).at(-1)).toBe("Cost $0.012");
    expect(formatRunUsageSummary(usage(), m)).not.toContain("Cost $0");
    expect(formatRunCost(usage({ costUsd: 0.5, costBilled: true }), m)).toBe(
      "Cost: $0.500, as the provider billed it",
    );
    expect(formatRunCost(usage({ costUsd: 0.5 }), m)).toBe(
      "Cost: $0.500, estimated from list prices",
    );
    expect(formatRunCost(usage(), m)).toBe("Cost: no price is known for this model");
  });

  it("sums the chat's answers whose cost is known, a rewritten one too, and counts the rest", () => {
    expect(chatCost([])).toBeNull();
    expect(chatCost([{ usage: usage() }])).toBeNull();
    const cost = chatCost([
      { usage: usage({ costUsd: 0.25, costBilled: true }) },
      { usage: usage({ costUsd: 0.5, costBilled: false }) },
      { usage: usage() },
      { usage: undefined },
    ]);
    expect(cost).toEqual({ costUsd: 0.75, billed: false, unpriced: 1 });
    expect(formatChatCost(cost!, m)).toEqual([
      "This chat: $0.750, estimated from list prices",
      "1 answers without a known price are not included",
    ]);
    expect(chatCost([{ usage: usage({ costUsd: 1, costBilled: true }) }])?.billed).toBe(true);
  });
});

describe("an answer's usage", () => {
  // The language is module state: a test that ran before this one in the same worker may have switched it.
  beforeEach(() => setActiveLocale(DEFAULT_LOCALE));

  it("rounds each share to a whole percent and has none with nothing to divide by", () => {
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(2, 3)).toBe(67);
    expect(sharePercent(0, 0)).toBeNull();
    expect(sharePercent(5, 4)).toBe(100);
    expect(cacheSharePercent(usage())).toBe(85);
    expect(earlierConversationCacheSharePercent(usage())).toBe(70);
    expect(cacheSharePercent(usage({ inputTokens: 0, cachedInputTokens: 0 }))).toBeNull();
    expect(contextSharePercent(usage())).toBe(7);
    expect(contextSharePercent(usage({ maxContextTokens: null }))).toBeNull();
  });

  it("summarizes the counts and leaves out a share whose denominator is 0", () => {
    expect(formatRunUsageSummary(usage(), m)).toEqual([
      "Input 12k",
      "Cache 85%(earlier conversation 70%)",
      "Output 1.2k",
      "Requests 4",
    ]);
    expect(
      formatRunUsageSummary(usage({ firstInputTokens: 0, firstCachedInputTokens: 0 }), m),
    ).toEqual(["Input 12k", "Cache 85%", "Output 1.2k", "Requests 4"]);
    expect(formatRunUsageSummary(usage({ inputTokens: 0, cachedInputTokens: 0 }), m)).toEqual([
      "Input 0",
      "Output 1.2k",
      "Requests 4",
    ]);
    expect(formatCacheShares(usage({ firstInputTokens: 0 }), m)).toEqual([
      "Input served from the cache: 85%",
    ]);
  });

  it("says how much context the conversation holds, of how much when the model says", () => {
    const count = (value: number) => value.toLocaleString("en");
    expect(formatContextUsage(usage(), m, count)).toBe("Context: 14,000 of 200,000 tokens (7%)");
    expect(formatContextUsage(usage({ maxContextTokens: null }), m, count)).toBe(
      "Context: 14,000 tokens",
    );
  });

  it("reads the conversation's context from its latest answer that recorded usage", () => {
    const first = usage({ contextTokens: 1 });
    const second = usage({ contextTokens: 2 });
    expect(latestRunUsage([])).toBeNull();
    expect(
      latestRunUsage([
        { ordinal: 2, status: "completed", usage: second },
        { ordinal: 1, status: "completed", usage: first },
        { ordinal: 3, status: "running" },
      ]),
    ).toBe(second);
    // An answer a rewrite took back no longer speaks for the conversation.
    expect(
      latestRunUsage([
        { ordinal: 1, status: "completed", usage: first },
        { ordinal: 2, status: "rolled_back", usage: second },
      ]),
    ).toBe(first);
  });
});
