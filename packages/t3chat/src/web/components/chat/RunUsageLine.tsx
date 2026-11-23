import type { OrchestrationV2RunUsage } from "@t3tools/contracts";
import { useGT, useLocale, useMessages } from "gt-react";
import { memo } from "react";

import {
  formatRunUsageDetail,
  formatRunUsageSummary,
  RUN_USAGE_SEPARATOR,
} from "~/lib/runUsage";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * FlareChat: the small line under an answer saying what it read and wrote, e.g.
 * 入力 12k・キャッシュ 85%（前の会話 70%）・出力 1.2k・リクエスト 4回. Hovering or tapping it names
 * every figure in words. Each part keeps to one line, so a phone wraps the line between parts.
 */
export const RunUsageLine = memo(function RunUsageLine({
  usage,
  className,
}: {
  usage: OrchestrationV2RunUsage;
  className?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const parts = formatRunUsageSummary(usage, m);
  const formatCount = (value: number) => value.toLocaleString(locale);
  const detail = formatRunUsageDetail(usage, m, formatCount);
  const label = gt("What this answer read and wrote: {summary}", {
    summary: parts.join(RUN_USAGE_SEPARATOR),
  });

  return (
    <div data-run-usage="true" className={cn("flex min-w-0", className)}>
      <Popover>
        <PopoverTrigger
          openOnHover
          render={
            <button
              type="button"
              aria-label={label}
              className="min-w-0 max-w-full cursor-default rounded-sm px-1 text-start text-2xs text-muted-foreground/80 tabular-nums outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {parts.map((part, index) => (
            <span key={index}>
              {index > 0 ? RUN_USAGE_SEPARATOR : null}
              <span className="whitespace-nowrap">{part}</span>
            </span>
          ))}
        </PopoverTrigger>
        <PopoverPopup
          tooltipStyle
          side="top"
          align="start"
          aria-label={gt("What this answer read and wrote")}
          className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
        >
          <ul className="grid gap-0.5 py-0.5 tabular-nums">
            {detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </PopoverPopup>
      </Popover>
    </div>
  );
});
