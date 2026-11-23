import type { OrchestrationV2Run, OrchestrationV2RunUsage } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MessageResolver } from "~/i18n/messages";
import { formatContextWindowTokens } from "./contextWindow";

/**
 * FlareChat: what one Operator Chat answer read and wrote, from its run's `usage`, and how much of
 * the conversation its model now holds, and what the answer and the whole chat cost. Runs written
 * before usage was recorded carry none, and nothing is shown for them; a run whose model no price
 * is known for carries no cost.
 */

/** `part` of `whole` as a whole percent, or null when there is nothing to divide by. */
export function sharePercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((Math.min(Math.max(part, 0), whole) / whole) * 100);
}

/** How much of the answer's input the provider served from its prompt cache. */
export function cacheSharePercent(usage: OrchestrationV2RunUsage): number | null {
  return sharePercent(usage.cachedInputTokens, usage.inputTokens);
}

/** How much of the conversation before this message the first request read again from the cache. */
export function earlierConversationCacheSharePercent(usage: OrchestrationV2RunUsage): number | null {
  return sharePercent(usage.firstCachedInputTokens, usage.firstInputTokens);
}

/** How full the model's context window is, or null when the provider does not say how large it is. */
export function contextSharePercent(usage: OrchestrationV2RunUsage): number | null {
  return usage.maxContextTokens === null
    ? null
    : sharePercent(usage.contextTokens, usage.maxContextTokens);
}

/**
 * The usage of the latest answer that has one: what the conversation holds now. An answer taken
 * back by a rewrite no longer speaks for the conversation.
 */
export function latestRunUsage(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status" | "usage">>,
): OrchestrationV2RunUsage | null {
  let latest: Pick<OrchestrationV2Run, "ordinal" | "usage"> | null = null;
  for (const run of runs) {
    if (run.usage === undefined || run.status === "rolled_back") continue;
    if (latest === null || run.ordinal >= latest.ordinal) latest = run;
  }
  return latest?.usage ?? null;
}

/**
 * A cost in US dollars as short as it reads: two decimals from a dollar, three below it, and two
 * significant figures below a cent, so a request of a fraction of a cent still reads as more than
 * nothing.
 */
export function formatCostUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value < 0.0001) return "<$0.0001";
  return `$${Number(value.toPrecision(2))}`;
}

/** What the whole chat cost: every answer whose cost is known, a rewritten one too, since it was paid for. */
export interface ChatCost {
  costUsd: number;
  /** Whether every counted answer's cost is the provider's bill rather than an estimate. */
  billed: boolean;
  /** Answers that recorded usage but no cost, left out of the sum. */
  unpriced: number;
}

/** The chat's cost, or null when no answer's cost is known. */
export function chatCost(runs: ReadonlyArray<Pick<OrchestrationV2Run, "usage">>): ChatCost | null {
  let costUsd = 0;
  let priced = 0;
  let unpriced = 0;
  let billed = true;
  for (const run of runs) {
    if (run.usage === undefined) continue;
    if (run.usage.costUsd === undefined) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    costUsd += run.usage.costUsd;
    billed &&= run.usage.costBilled === true;
  }
  return priced === 0 ? null : { costUsd, billed, unpriced };
}

/** The chat's cost in words, one line each, for the composer meter's detail. */
export function formatChatCost(cost: ChatCost, resolve: MessageResolver): ReadonlyArray<string> {
  const amount = formatCostUsd(cost.costUsd);
  return [
    cost.billed
      ? resolve(msg("This chat: {cost}, as the provider billed it", { cost: amount }))
      : resolve(msg("This chat: {cost}, estimated from list prices", { cost: amount })),
    ...(cost.unpriced === 0
      ? []
      : [
          resolve(
            msg("{count} answers without a known price are not included", {
              count: cost.unpriced,
            }),
          ),
        ]),
  ];
}

/** What the answer cost in words, for its detail. */
export function formatRunCost(usage: OrchestrationV2RunUsage, resolve: MessageResolver): string {
  if (usage.costUsd === undefined) return resolve(msg("Cost: no price is known for this model"));
  const cost = formatCostUsd(usage.costUsd);
  return usage.costBilled === true
    ? resolve(msg("Cost: {cost}, as the provider billed it", { cost }))
    : resolve(msg("Cost: {cost}, estimated from list prices", { cost }));
}

/** What joins the summary's parts, as Japanese lists them. */
export const RUN_USAGE_SEPARATOR = "・";

/**
 * The answer's one-line summary as its parts, e.g. 入力 12k, キャッシュ 85%（前の会話 70%）,
 * 出力 1.2k, リクエスト 4回, 費用 $0.012; a share with nothing to divide by, and a cost no price
 * is known for, is left out.
 */
export function formatRunUsageSummary(
  usage: OrchestrationV2RunUsage,
  resolve: MessageResolver,
): ReadonlyArray<string> {
  const cache = cacheSharePercent(usage);
  const earlier = earlierConversationCacheSharePercent(usage);
  const cachePart =
    cache === null
      ? null
      : `${resolve(msg("Cache {percent}%", { percent: cache }))}${
          earlier === null
            ? ""
            : resolve(msg("(earlier conversation {percent}%)", { percent: earlier }))
        }`;
  return [
    resolve(msg("Input {tokens}", { tokens: formatContextWindowTokens(usage.inputTokens) })),
    cachePart,
    resolve(msg("Output {tokens}", { tokens: formatContextWindowTokens(usage.outputTokens) })),
    resolve(msg("Requests {count}", { count: usage.requests })),
    usage.costUsd === undefined
      ? null
      : resolve(msg("Cost {cost}", { cost: formatCostUsd(usage.costUsd) })),
  ].filter((part): part is string => part !== null);
}

/** The context the conversation holds, in words: of how much, when the provider says. */
export function formatContextUsage(
  usage: OrchestrationV2RunUsage,
  resolve: MessageResolver,
  formatCount: (value: number) => string,
): string {
  const percent = contextSharePercent(usage);
  return usage.maxContextTokens === null || percent === null
    ? resolve(msg("Context: {tokens} tokens", { tokens: formatCount(usage.contextTokens) }))
    : resolve(
        msg("Context: {tokens} of {max} tokens ({percent}%)", {
          tokens: formatCount(usage.contextTokens),
          max: formatCount(usage.maxContextTokens),
          percent,
        }),
      );
}

/** The cache shares, in words, for a tooltip; a share with nothing to divide by is left out. */
export function formatCacheShares(
  usage: OrchestrationV2RunUsage,
  resolve: MessageResolver,
): ReadonlyArray<string> {
  const cache = cacheSharePercent(usage);
  const earlier = earlierConversationCacheSharePercent(usage);
  return [
    cache === null
      ? null
      : resolve(msg("Input served from the cache: {percent}%", { percent: cache })),
    earlier === null
      ? null
      : resolve(
          msg("Of the earlier conversation, served again from the cache: {percent}%", {
            percent: earlier,
          }),
        ),
  ].filter((line): line is string => line !== null);
}

/** Every field of the answer's usage in words, one line each, for its detail. */
export function formatRunUsageDetail(
  usage: OrchestrationV2RunUsage,
  resolve: MessageResolver,
  formatCount: (value: number) => string,
): ReadonlyArray<string> {
  const earlier = earlierConversationCacheSharePercent(usage);
  return [
    resolve(msg("Model requests: {count}", { count: usage.requests })),
    resolve(msg("Input: {tokens} tokens", { tokens: formatCount(usage.inputTokens) })),
    resolve(
      msg("Read from the cache: {tokens} tokens", {
        tokens: formatCount(usage.cachedInputTokens),
      }),
    ),
    resolve(
      msg("Written to the cache: {tokens} tokens", {
        tokens: formatCount(usage.cacheWriteTokens),
      }),
    ),
    resolve(msg("Output: {tokens} tokens", { tokens: formatCount(usage.outputTokens) })),
    ...(earlier === null
      ? []
      : [
          resolve(
            msg("First request: {cached} of {input} tokens from the cache", {
              cached: formatCount(usage.firstCachedInputTokens),
              input: formatCount(usage.firstInputTokens),
            }),
          ),
        ]),
    ...formatCacheShares(usage, resolve),
    formatContextUsage(usage, resolve, formatCount),
    formatRunCost(usage, resolve),
  ];
}
