/**
 * FlareChat's approval modes on t3code's runtime-mode control. A conversation's mode is kept on
 * its thread as one of t3code's four RuntimeMode literals, so the copied composer shows and
 * changes it; each stands for one of FlareChat's four. Three are named alike (approval-required
 * asks, auto lets a judge decide, full-access never asks); t3code's auto-accept-edits, which
 * FlareChat has no use for, stands for read-only, and the composer lists read-only first.
 */
import type { RuntimeMode } from '@t3tools/contracts/providerPolicy.ts';

import type { ChatMode } from './api.ts';

const RUNTIME_MODES: Readonly<Record<ChatMode, RuntimeMode>> = {
  read_only: 'auto-accept-edits',
  ask: 'approval-required',
  auto: 'auto',
  unrestricted: 'full-access',
};

export const runtimeModeOf = (mode: ChatMode): RuntimeMode => RUNTIME_MODES[mode];

export const chatModeOf = (mode: RuntimeMode): ChatMode =>
  (Object.entries(RUNTIME_MODES) as Array<[ChatMode, RuntimeMode]>).find(([, runtime]) => runtime === mode)?.[0] ?? 'ask';
