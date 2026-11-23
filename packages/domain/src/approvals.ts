/**
 * How a conversation of Operator Chat (ADR 0201) treats the calls
 * that write or act (`asksApproval` in tools.ts): each conversation has one
 * approval mode, chosen in its composer, and it applies from the next call.
 *
 * - `read_only` offers no such tool at all.
 * - `ask` asks before every one, except opening a page in the browser and
 *   reading it.
 * - `auto` asks a Decider, which lets a call through or asks; when it fails,
 *   it asks. It is offered only where the Worker holds an OpenRouter key, and
 *   a conversation kept in it elsewhere is `unrestricted`.
 * - `unrestricted` never asks.
 *
 * A tool a person allowed always, for the Account, is not asked about again
 * in `ask` or `auto`; `read_only` still offers it not.
 */

export type ChatMode = 'read_only' | 'ask' | 'auto' | 'unrestricted';

export const CHAT_MODES: readonly ChatMode[] = ['read_only', 'ask', 'auto', 'unrestricted'];

/** The mode a person's first conversation starts in; each later one starts in the mode of the latest they created or changed. */
export const DEFAULT_CHAT_MODE: ChatMode = 'unrestricted';

export const CHAT_MODE_LABELS: Readonly<Record<ChatMode, string>> = {
  read_only: '読み取りのみ',
  ask: '要承認',
  auto: '自動',
  unrestricted: '無制限',
};

export const isChatMode = (value: unknown): value is ChatMode =>
  typeof value === 'string' && (CHAT_MODES as readonly string[]).includes(value);

/** How a person answers a call waiting for approval: once, always for the Account, or not. */
export type ChatApproval = 'accept' | 'acceptAlways' | 'decline';

export const CHAT_APPROVAL_LABELS: Readonly<Record<ChatApproval, string>> = {
  accept: '今回だけ許可',
  acceptAlways: '今後も許可',
  decline: '拒否',
};

export const isChatApproval = (value: unknown): value is ChatApproval =>
  value === 'accept' || value === 'acceptAlways' || value === 'decline';
