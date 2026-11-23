import type { OrchestrationV2Run } from "@t3tools/contracts";
import { useGT, useLocale, useMessages } from "gt-react";
import { memo, type PointerEventHandler } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  chatCost,
  contextSharePercent,
  formatCacheShares,
  formatChatCost,
  formatCostUsd,
  formatContextUsage,
  latestRunUsage,
} from "~/lib/runUsage";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

const RING_RADIUS = 5.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing({ percent }: { percent: number }) {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className="opacity-20"
      />
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        // A sliver stays drawn, so a conversation just begun still reads as a meter.
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(percent, 2) / 100)}
      />
    </svg>
  );
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/**
 * FlareChat: how much of the model's context the conversation holds, from the latest answer that
 * recorded it: a ring and its percent when the model's window is known, otherwise the token count.
 * Beside it, what the whole chat has cost, where any answer's price is known. Hovering or tapping
 * it tells how much of that answer's input came from the prompt cache, and whether the chat's cost
 * is a bill or an estimate. Hidden until an answer has recorded its usage.
 */
export const ComposerContextMeter = memo(function ComposerContextMeter({
  runs,
  preserveComposerFocusOnPointerDown = false,
}: {
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status" | "usage">>;
  preserveComposerFocusOnPointerDown?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usage = latestRunUsage(runs);
  if (usage === null) return null;

  const percent = contextSharePercent(usage);
  const tokens = formatContextWindowTokens(usage.contextTokens);
  const formatCount = (value: number) => value.toLocaleString(locale);
  const context = formatContextUsage(usage, m, formatCount);
  const shares = formatCacheShares(usage, m);
  const cost = chatCost(runs);
  const costLines = cost === null ? [] : formatChatCost(cost, m);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        data-chat-composer-context-meter="true"
        render={
          <button
            type="button"
            aria-label={[context, ...costLines].join(" ")}
            onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
            className={cn(
              "flex h-7 shrink-0 cursor-default items-center gap-1 rounded-(--control-radius) px-1.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              // A phone's open composer has no room beside its attach buttons; its resting row shows the meter.
              "@max-[480px]/composer-surface:in-data-[chat-composer-controls=footer]:hidden",
              percent !== null && percent >= 90
                ? "text-destructive-foreground"
                : percent !== null && percent >= 75
                  ? "text-warning-foreground"
                  : null,
            )}
          />
        }
      >
        {percent === null || usage.maxContextTokens === null ? (
          <span className="whitespace-nowrap">{gt("Context {tokens}", { tokens })}</span>
        ) : (
          <>
            <ContextRing percent={percent} />
            <span className="whitespace-nowrap">{percent}%</span>
            <span className="whitespace-nowrap text-muted-foreground/70 @max-[480px]/composer-surface:hidden">
              {tokens}/{formatContextWindowTokens(usage.maxContextTokens)}
            </span>
          </>
        )}
        {cost === null ? null : (
          <span data-chat-cost="true" className="whitespace-nowrap">
            {formatCostUsd(cost.costUsd)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        // Inside the composer's own layer, so opening it from a phone's resting row keeps the composer resting.
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        aria-label={gt("Context")}
        className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
      >
        <div className="grid gap-0.5 py-0.5 tabular-nums">
          <div>{context}</div>
          {costLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
          {shares.length > 0 ? (
            <>
              <div className="mt-1 font-medium">{gt("Latest answer")}</div>
              {shares.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
