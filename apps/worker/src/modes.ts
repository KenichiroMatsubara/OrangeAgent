/**
 * Which approval modes Operator Chat (ADR 0201) offers. 自動 asks
 * a Decider, which the Worker can ask only with an OpenRouter key; without
 * one, 自動 is not offered, setting it is refused, and a conversation kept in
 * it is 無制限, both for its calls and for what its composer shows.
 */

import { CHAT_MODES, type ChatMode } from '@mail/domain';

import type { Bindings } from './types';

/** Whether the Worker can ask a Decider, which it can only with an OpenRouter key. */
export const decides = (env: Pick<Bindings, 'OPENROUTER_API_KEY'>): boolean => Boolean(env.OPENROUTER_API_KEY?.trim());

/** The modes a conversation can be set to, read-only first: 自動 only where a Decider can be asked. */
export const offeredModes = (decider: boolean): ChatMode[] => CHAT_MODES.filter((mode) => decider || mode !== 'auto');

/** The mode a conversation kept in `mode` is in: 自動 is 無制限 where no Decider can be asked. */
export const modeIn = (mode: ChatMode, decider: boolean): ChatMode => mode === 'auto' && !decider ? 'unrestricted' : mode;
