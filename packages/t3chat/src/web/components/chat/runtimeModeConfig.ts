import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contractLabels.ts";
import { msg } from "gt-react";
import type { ManagedPolicySummary, RuntimeMode } from "@t3tools/contracts";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  type LucideIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

// OrangeAgent's four approval modes on t3code's four runtime modes (chat/modes.ts), read-only first.
export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "auto-accept-edits": {
    label: "読み取りのみ",
    description: "書き込むツールを使いません。",
    icon: LockIcon,
  },
  "approval-required": {
    label: "要承認",
    description: "書き込む前に毎回確認します。ページを開いて読むだけなら確認しません。",
    icon: PenLineIcon,
  },
  auto: {
    label: "自動",
    description: "危ない書き込みだけ確認します。判定できないときも確認します。",
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: "無制限",
    description: "確認せずに書き込みます。",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOption(
  mode: RuntimeMode,
  resolve: MessageResolver = m,
): {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  disabledReason?: string;
} {
  const config = runtimeModeConfig[mode];
  return {
    mode,
    ...config,
    label: resolve(config.label),
    description: resolve(config.description),
  };
}

/** Why `mode` is unavailable under `managedPolicy`, or undefined when it is allowed. */
export function runtimeModeDenial(
  managedPolicy: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: MessageResolver = m,
) {
  const ceiling = managedPolicy?.limits?.maxRuntimeMode;
  if (ceiling === undefined || managedRuntimeModeDenial(managedPolicy, mode) === undefined) {
    return undefined;
  }
  return resolve(
    msg("{organization} limits threads to {mode}.", {
      organization: managedPolicy!.organization,
      mode: resolve(runtimeModeConfig[ceiling].label),
    }),
  );
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
  resolve: MessageResolver = m,
) {
  return modes.map((mode) => {
    const option = resolveRuntimeModeOption(mode, resolve);
    const disabledReason = runtimeModeDenial(managedPolicy, mode, resolve);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
