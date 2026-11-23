import type { AiProvider, McpAuthentication, AttendanceStatus, MemoryAuthorKind, MemoryChange, MemoryEpisodeSource, MemoryProvenance, MemoryStatus, AutomationStatus, Contact, ExecutionMode, LineHandleKind, PlannedWriteStatus, RunStatus, RunTrigger, MinutesState, TranscriptState } from '@mail/domain';
import { TOOL_LABELS } from '@mail/domain';

import type { Tone } from './ui/notice';

/**
 * The words the GUI uses for the Worker's identifiers. No screen
 * shows an enumerated value as it is stored; it looks the value up here, and a
 * value this table does not know yet is shown as it is rather than hidden.
 */

export interface Named {
  label: string;
  tone: Tone;
}

/** The name and tone of a value from a table, or the value itself when the table predates it. */
export const named = <K extends string>(table: Readonly<Record<K, Named>>, value: string): Named =>
  (table as Readonly<Record<string, Named>>)[value] ?? { label: value, tone: 'neutral' };

/** Only the name, for tables without a tone. */
export const word = <K extends string>(table: Readonly<Record<K, string>>, value: string): string =>
  (table as Readonly<Record<string, string>>)[value] ?? value;

export const transcriptState: Readonly<Record<TranscriptState, Named>> = {
  transcribing: { label: '文字起こし中', tone: 'info' },
  completed: { label: '文字起こし済み', tone: 'brand' },
  failed: { label: '失敗', tone: 'danger' },
};

export const minutesState: Readonly<Record<MinutesState, Named>> = {
  writing: { label: '議事録を作成中', tone: 'info' },
  completed: { label: '議事録あり', tone: 'brand' },
  failed: { label: '議事録は失敗', tone: 'danger' },
};

/** How an MCP Server is called. */
export const mcpAuthentication: Readonly<Record<McpAuthentication, string>> = {
  none: '認証なし',
  token: 'トークンあり',
  oauth: 'サインイン済み',
};

/** Whether an Automation runs at its time: on or off. */
export const automationSwitch = (enabled: boolean): Named =>
  enabled ? { label: 'オン', tone: 'brand' } : { label: 'オフ', tone: 'muted' };

/** What starts a Run, as a person says it. */
export const trigger: Readonly<Record<RunTrigger, string>> = {
  mail: 'メールが届いたとき（以前の仕組み）',
  morning: '朝のお知らせ（以前の仕組み）',
  schedule: '決まった時刻に',
  chat: 'チャット',
};

export const executionMode: Readonly<Record<ExecutionMode, Named>> = {
  read_only: { label: '見るだけ', tone: 'neutral' },
  approval: { label: '承認してから実行', tone: 'warn' },
  unattended: { label: '自動で実行', tone: 'brand' },
};

/** What each Execution Mode does, in one sentence for the place it is chosen. */
export const executionModeHint: Readonly<Record<ExecutionMode, string>> = {
  read_only: '計画を立てるだけで、何も書き込まず、誰にも送りません。',
  approval: '計画を立てて待ちます。承認すると、計画どおりに書き込み、送ります。',
  unattended: '計画したことをそのまま実行します。',
};

export const runStatus: Readonly<Record<RunStatus, Named>> = {
  planning: { label: '計画中', tone: 'neutral' },
  read_only: { label: '見るだけ', tone: 'neutral' },
  pending_approval: { label: '承認待ち', tone: 'warn' },
  applying: { label: '実行中', tone: 'info' },
  completed: { label: '完了', tone: 'brand' },
  rejected: { label: '却下', tone: 'muted' },
  expired: { label: '期限切れ', tone: 'muted' },
  failed: { label: '失敗', tone: 'danger' },
};

export const plannedWriteStatus: Readonly<Record<PlannedWriteStatus, Named>> = {
  planned: { label: '予定', tone: 'neutral' },
  pending: { label: '待機中', tone: 'neutral' },
  applying: { label: '実行中', tone: 'info' },
  succeeded: { label: '成功', tone: 'brand' },
  transient_failed: { label: '再試行待ち', tone: 'warn' },
  permanent_failed: { label: '失敗', tone: 'danger' },
  blocked: { label: '止めました', tone: 'warn' },
  rejected: { label: '却下', tone: 'muted' },
  expired: { label: '期限切れ', tone: 'muted' },
};

export const attendance: Readonly<Record<AttendanceStatus, Named>> = {
  unanswered: { label: '未回答', tone: 'warn' },
  attending: { label: '出席', tone: 'brand' },
  not_attending: { label: '欠席', tone: 'muted' },
};

export const inboxStatus: Readonly<Record<AutomationStatus['status'], Named>> = {
  active: { label: '接続中', tone: 'brand' },
  reauthentication_required: { label: '再接続が必要', tone: 'danger' },
  disconnected: { label: '切断', tone: 'muted' },
};

export const contactState: Readonly<Record<Contact['state'], Named>> = {
  active: { label: '有効', tone: 'brand' },
  inactive: { label: '無効', tone: 'muted' },
};

export const channel: Readonly<Record<string, string>> = {
  email: 'メール',
  line: 'LINE',
  discord: 'Discord',
};

export const lineHandleKind: Readonly<Record<LineHandleKind, string>> = {
  user: '個人',
  group: 'グループ',
  room: 'トークルーム',
};

/** How long the same send is held back after it was made once (the Suppression Window). */
export const suppressionWindow: Readonly<Record<string, string>> = {
  none: '止めない',
  hour: '1時間',
  day: '1日',
  week: '1週間',
  forever: 'ずっと',
};

/** The tools an Automation or an Access Token may be granted, by what they let it do; the Worker names a tool waiting for approval by the same words. */
export const tool: Readonly<Record<string, string>> = TOOL_LABELS;

/** Who wrote a memory, as 記憶 says it. */
export const memoryAuthor: Readonly<Record<MemoryAuthorKind, string>> = {
  chat: 'AI（チャット）',
  cli: 'AI（CLI）',
  person: '人',
};

/** Whether a memory is found, as 記憶 says it. Only an active one is. */
export const memoryStatus: Readonly<Record<MemoryStatus, string>> = {
  candidate: '確認待ち',
  active: '使われる',
  superseded: '新しい記憶に置き換え',
  rejected: '覚えなかった',
  forgotten: '忘れた',
};

/** Who said what a memory rests on, as 記憶 says it. */
export const memoryProvenance: Readonly<Record<MemoryProvenance, string>> = {
  member: '人が言ったこと',
  confirmed: 'AI が実行して確かめたこと',
  proposed: 'AI が書いたこと',
  inferred: '推測',
  external: 'メールなど外の資料',
};

/** Where the words a memory rests on came from, as 記憶 says it. */
export const memoryEpisodeSource: Readonly<Record<MemoryEpisodeSource, string>> = {
  chat: 'チャットのやり取り',
  cli: 'CLI の AI が渡した文',
  person: '記憶の画面で人が書いた文',
  legacy: '以前の方式で AI か人が書いた文',
};

/** Who changed a memory, as its history says it. */
export const memoryChangeActor: Readonly<Record<MemoryChange['actor']['kind'], string>> = {
  pipeline: '自動の確認',
  member: '人',
  chat: 'AI（チャット）',
  cli: 'AI（CLI）',
  maintenance: '整理',
};

/** What a change did to a memory, as its history says it; an unknown action is shown as it is recorded. */
export const memoryChangeAction: Readonly<Record<string, string>> = {
  add: '覚えた',
  correct: '直した',
  erase: '削除した',
  import: '以前の方式から移した',
};

/** The API an AI Connection is on, by the name a person knows it. */
export const aiProviderName: Readonly<Record<AiProvider, string>> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

/** Where each provider's model runs code (ADR 0202), as the AI Connection's sheet says it. */
export const aiProviderEnvironment: Readonly<Record<AiProvider, string>> = {
  anthropic: 'Claude は Anthropic のサンドボックスでコードを動かし、ウェブも調べます。',
  openai: 'OpenAI のコードインタープリターでコードを動かします。メモリは作業から見積もって 1〜64 GB を借ります。',
  gemini: 'Gemini のコード実行でコードを動かします。書き出せるのはグラフなどの画像だけです。',
  openrouter: 'OpenRouter のモデルは OrangeAgent が用意する実行環境でコードを動かします。軽い作業は Dynamic Worker、重い作業はメモリを見積もって 256 MiB〜12 GiB のコンテナです。',
};

/** What the model field suggests typing, by provider. */
export const aiModelExample: Readonly<Record<AiProvider, string>> = {
  anthropic: '例: claude-opus-4-1',
  openai: '例: gpt-5.5',
  gemini: '例: gemini-3-flash',
  openrouter: '例: openai/gpt-5.5',
};
