/**
 * A conversation served from the page, for the mocked GUI (`npm run dev:mock`). It plays the
 * shared prototype scenario with the Operator Chat's own tools: a snapshot with one finished turn
 * and one still working — a call that failed, and a subagent whose own conversation opens beside
 * it — then numbered events: a tool finishing, an answer with a table, a chart, and a PDF
 * streaming in, and two writes that wait for approval in turn, each described as the Worker
 * describes it. Answering resolves them and a long answer follows; a sent message gets a short
 * reply. An earlier message rewritten rolls back the answers from it on and is answered again; an
 * answer continued from opens a conversation of its own, `thread-teirei-fork`, holding the
 * conversation up to it. It offers three models, and saves to and attaches from a Drive of its own.
 * Every answer records what it read and wrote, as the Worker does after each model request.
 */
import {
  ChatAttachmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from '@t3tools/contracts';
import * as DateTime from 'effect/DateTime';

import { callPreview, toolLabel, type PreviewEvent } from '@mail/domain';

import type { ChatCapabilities, ChatDecision, ChatMode, ChatSuggestion, ChatTransport } from './api.ts';
import { runtimeModeOf } from './modes.ts';
import { encodeFrame } from './stream.ts';

type TurnItem = OrchestrationV2TurnItem;
type AssistantItem = Extract<TurnItem, { readonly type: 'assistant_message' }>;
type ToolItem = Extract<TurnItem, { readonly type: 'dynamic_tool' }>;
type ApprovalItem = Extract<TurnItem, { readonly type: 'approval_request' }>;
type Status = TurnItem['status'];
type EventOf<T extends OrchestrationV2DomainEvent['type']> = Extract<OrchestrationV2DomainEvent, { readonly type: T }>;

export const FAKE_THREAD_ID = 'thread-teirei';
/** The conversation continuing the sample from one of its answers, as the sample's 「ここから新しい会話で続ける」 opens it. */
export const FAKE_FORK_ID = 'thread-teirei-fork';
/** The models the sample's AI Connection names, the default first; neutral names, as a mock names no real model. */
const FAKE_CAPABILITIES: ChatCapabilities = {
  models: ['standard-model', 'fast-model', 'reasoning-model'],
  efforts: { 'standard-model': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }, 'reasoning-model': { levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: null } },
  drivePicker: true,
};
const THREAD_ID = ThreadId.make(FAKE_THREAD_ID);
/** The subagent's own conversation, which the Worker does not have yet: only the sample plays one. */
const CHILD_THREAD_ID = ThreadId.make('thread-teirei-chosa');
const RUN_1 = RunId.make('run-1');
const RUN_2 = RunId.make('run-2');
const PROVIDER = ProviderInstanceId.make('flarechat');
const MODEL = { instanceId: PROVIDER, model: 'flarechat' };
/** The modes the sample conversation offers: those of a deployment without an OpenRouter key. */
const OFFERED_MODES: ReadonlyArray<ChatMode> = ['read_only', 'ask', 'unrestricted'];
const TURN_2 = 300;
/** The scenario's times count seconds from here: the second turn began a minute before it loads. */
const START_MS = Date.now() - (TURN_2 + 60) * 1000;

const at = (second: number): DateTime.Utc => DateTime.makeUnsafe(START_MS + second * 1000);
const now = (): DateTime.Utc => DateTime.makeUnsafe(Date.now());

const IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f4f1ea"/><rect x="24" y="22" width="272" height="156" rx="6" fill="#fff" stroke="#c9c2b4"/><text x="40" y="58" font-size="20" font-family="sans-serif" fill="#333">請求書</text><rect x="40" y="76" width="200" height="8" fill="#ddd"/><rect x="40" y="94" width="160" height="8" fill="#ddd"/><text x="40" y="156" font-size="16" font-family="sans-serif" fill="#a33">¥88,000</text></svg>')}`;

const CHART = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#fff"/><text x="24" y="36" font-size="18" font-family="sans-serif" fill="#333">10月の請求（円）</text><line x1="40" y1="230" x2="456" y2="230" stroke="#999"/><rect x="70" y="70" width="90" height="160" fill="#d9534f"/><rect x="200" y="134" width="90" height="96" fill="#5b8def"/><rect x="330" y="150" width="90" height="80" fill="#5b8def"/><text x="78" y="62" font-size="14" font-family="sans-serif" fill="#333">88,000</text><text x="208" y="126" font-size="14" font-family="sans-serif" fill="#333">52,800</text><text x="338" y="142" font-size="14" font-family="sans-serif" fill="#333">44,000</text><text x="70" y="254" font-size="13" font-family="sans-serif" fill="#555">ミナト</text><text x="200" y="254" font-size="13" font-family="sans-serif" fill="#555">青葉</text><text x="330" y="254" font-size="13" font-family="sans-serif" fill="#555">北斗</text></svg>')}`;

/** A one-page PDF whose lines are ASCII, as the bytes a file holds. */
const pdfText = (lines: ReadonlyArray<string>): string => {
  const content = `BT /F1 14 Tf 72 760 Td ${lines.map((line, index) => `${index === 0 ? '' : '0 -22 Td '}(${line}) Tj`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${text}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
};

/** Where the sample PDF is read: a blob the browser opens, or its bytes as data where there is no blob URL. */
const pdfUrl = (): string => {
  const text = pdfText(['Invoices, October 2026', 'Minato Co.      88,000 JPY   due 11/30   unpaid', 'Aoba Design     52,800 JPY   paid', 'Hokuto Systems  44,000 JPY   paid']);
  return typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(new Blob([text], { type: 'application/pdf' }))
    : `data:application/pdf;base64,${btoa(text)}`;
};

const base = (id: string, run: RunId, start: number, end: number | null, status: Status) => ({
  id: TurnItemId.make(id),
  threadId: THREAD_ID,
  runId: run,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: start,
  status,
  title: null,
  startedAt: at(start),
  completedAt: end === null ? null : at(end),
  updatedAt: at(end ?? start),
});

const userMessage = (id: string, run: RunId, second: number, text: string, attachments: Extract<TurnItem, { readonly type: 'user_message' }>['attachments'] = []): TurnItem => ({
  ...base(id, run, second, second, 'completed'),
  type: 'user_message',
  messageId: MessageId.make(`m-${id}`),
  text,
  attachments,
  inputIntent: 'turn_start',
  createdBy: 'user',
  creationSource: 'web',
});

const assistant = (id: string, run: RunId, start: number, end: number, text: string): AssistantItem => ({
  ...base(id, run, start, end, 'completed'),
  type: 'assistant_message',
  messageId: MessageId.make(`m-${id}`),
  text,
  streaming: false,
});

const tool = (id: string, run: RunId, start: number, end: number | null, status: Status, toolName: string, input: unknown, output?: unknown): ToolItem => ({
  ...base(id, run, start, end, status),
  type: 'dynamic_tool',
  toolName,
  input,
  ...(output === undefined ? {} : { output }),
});

const APPROVAL_OPTIONS: ApprovalItem['options'] = [
  { decision: 'accept', label: '今回だけ許可' },
  { decision: 'acceptAlways', label: '今後も許可' },
  { decision: 'decline', label: '拒否' },
];

/** Why the sample asks, as a conversation in 要承認 says it. */
const ASKED = '要承認の会話なので、実行する前に確認します。';

const approval = (id: string, parent: ToolItem, requestId: RuntimeRequestId, second: number, before: PreviewEvent | null = null): ApprovalItem => ({
  ...base(id, RUN_2, second, null, 'waiting'),
  parentItemId: parent.id,
  type: 'approval_request',
  requestId,
  requestKind: 'permission',
  // As the Worker describes a waiting call: its tool in words, then what it will do.
  prompt: [toolLabel(parent.toolName ?? ''), callPreview(parent.toolName ?? '', parent.input as Readonly<Record<string, unknown>>, before) ?? ''].join('\n'),
  reason: ASKED,
  options: APPROVAL_OPTIONS,
});

const T1_USER = userMessage('t1-user', RUN_1, 0, '今日の予定を教えて');
const T1_REASONING: TurnItem = { ...base('t1-reasoning', RUN_1, 2, 6, 'completed'), type: 'reasoning', text: '今日のカレンダーを Asia/Tokyo で確認する。', streaming: false };
const T1_TOOL = tool('t1-tool', RUN_1, 7, 9, 'completed', 'calendar.search', { from: '2026-11-21T00:00:00+09:00', to: '2026-11-22T00:00:00+09:00' }, [
  { title: '週次定例', start: '10:00', end: '10:30' },
  { title: '歯医者', start: '18:00', end: '19:00' },
]);
const T1_ASSISTANT = assistant('t1-assistant', RUN_1, 60, 72, '今日は2件です。\n\n- 10:00〜10:30 週次定例\n- 18:00〜19:00 歯医者');

const T2_USER = userMessage('t2-user', RUN_2, TURN_2, '来週の定例を木曜15時に動かして、田中さんにメールで知らせて。あと先月の請求の件をまとめて', [
  { type: 'image', id: ChatAttachmentId.make('att-seikyusho'), name: '請求書.png', mimeType: 'image/png', sizeBytes: 48_213 },
]);
const T2_REASONING: TurnItem = {
  ...base('t2-reasoning', RUN_2, TURN_2 + 2, TURN_2 + 5, 'completed'),
  type: 'reasoning',
  text: '定例は毎週金曜10時。来週は11/27(金)。木曜は11/26。15:00〜15:30 の空きを先に確かめる。\n請求の件は件数が多いのでサブエージェントに任せる。',
  streaming: false,
};
const T2_FREE = tool('t2-free', RUN_2, TURN_2 + 6, TURN_2 + 7, 'completed', 'calendar.search', { from: '2026-11-26T15:00:00+09:00', to: '2026-11-26T15:30:00+09:00' }, []);
const T2_MAIL_SEARCH = tool('t2-mail-search', RUN_2, TURN_2 + 8, TURN_2 + 9, 'failed', 'mail.search', { query: 'from:billing@example.co.jp after:2026/10/01', limit: 20 }, 'Gmail の読み取り権限が失効しています（401）。設定 → Google 連携で再接続してください。');
// With the mail unread, the billing site is read in the Browser instead.
const T2_BROWSER_OPEN = tool('t2-browser-open', RUN_2, TURN_2 + 10, TURN_2 + 11, 'completed', 'browser.open', { url: 'https://billing.example.co.jp/invoices?month=2026-10' }, {
  url: 'https://billing.example.co.jp/invoices?month=2026-10',
  title: '請求書一覧 2026年10月',
});
const T2_BROWSER_READ = tool('t2-browser-read', RUN_2, TURN_2 + 12, TURN_2 + 13, 'completed', 'browser.read', {}, {
  url: 'https://billing.example.co.jp/invoices?month=2026-10',
  text: '請求書一覧 2026年10月\n株式会社ミナト ¥88,000 支払期日 2026/11/30 未払い\n青葉デザイン ¥52,800 支払済\n北斗システム ¥44,000 支払済',
});
const T2_SUBAGENT: TurnItem = {
  ...base('t2-subagent', RUN_2, TURN_2 + 14, TURN_2 + 41, 'completed'),
  title: '先月の請求メールを調べる',
  type: 'subagent',
  subagentId: NodeId.make('node-chosa'),
  origin: 'provider_native',
  driver: ProviderDriverKind.make('flarechat'),
  providerInstanceId: PROVIDER,
  childThreadId: CHILD_THREAD_ID,
  prompt: '先月（10月）の請求メールと添付を Drive から探し、取引先・金額・期日・支払状態をまとめる。',
  progress: 'Drive を探す → Drive のファイルを読む → Drive のファイルを読む',
  result: '10月分の請求は3件、合計 ¥184,800。うち1件（株式会社ミナト）は支払期日 11/30 が未払いです。',
};
// The chart is drawn with matplotlib in a container; the list is a PDF pdf-lib writes in a Dynamic Worker.
const T2_CHART = tool('t2-code-chart', RUN_2, TURN_2 + 42, TURN_2 + 43, 'completed', 'code.run', {
  language: 'python',
  code: "import matplotlib.pyplot as plt\nplt.bar(['ミナト', '青葉', '北斗'], [88000, 52800, 44000])\nplt.savefig('out/10月の請求内訳.png')",
}, { environment: 'コンテナ lite (256 MiB)', memoryMiB: 256, estimateMiB: 160, exitCode: 0, stdout: '', stderr: '', files: [{ filename: '10月の請求内訳.png', size: 23_404 }] });
const T2_PDF = tool('t2-code-pdf', RUN_2, TURN_2 + 44, TURN_2 + 45, 'completed', 'code.run', {
  language: 'javascript',
  code: "import { PDFDocument } from 'pdf-lib';\nconst pdf = await PDFDocument.create();\npdf.addPage().drawText('10月請求一覧');\noutput('10月請求一覧.pdf', await pdf.save());",
}, { environment: 'Dynamic Worker (128 MiB)', memoryMiB: 128, estimateMiB: 24, exitCode: 0, stdout: '', stderr: '', files: [{ filename: '10月請求一覧.pdf', size: 61_877 }] });
const T2_ASSISTANT: AssistantItem = {
  ...assistant('t2-assistant', RUN_2, TURN_2 + 46, TURN_2 + 50, [
    '先月の請求をまとめました。',
    '',
    '| 取引先 | 金額 | 期日 | 状態 |',
    '|---|---:|---|---|',
    '| 株式会社ミナト | ¥88,000 | 11/30 | **未払い** |',
    '| 青葉デザイン | ¥52,800 | 11/15 | 支払済 |',
    '| 北斗システム | ¥44,000 | 11/10 | 支払済 |',
    '',
    '内訳のグラフと一覧の PDF を付けました。定例の変更とメール送信は、確認をいただいてから行います。',
  ].join('\n')),
  attachments: [
    { type: 'image', id: ChatAttachmentId.make('att-chart'), name: '10月の請求内訳.png', mimeType: 'image/png', sizeBytes: 23_404 },
    { type: 'file', id: ChatAttachmentId.make('att-invoices'), name: '10月請求一覧.pdf', mimeType: 'application/pdf', sizeBytes: 61_877 },
  ],
};
/** The event the change names, as FlareChat recorded it. */
const WEEKLY: PreviewEvent = { title: '週次定例', startsAt: '2026-11-27T10:00:00+09:00', endsAt: '2026-11-27T10:30:00+09:00', location: '第2会議室' };
const T2_UPDATE = tool('t2-update-event', RUN_2, TURN_2 + 51, null, 'waiting', 'update_scheduled_event', { eventId: 'event-teirei-1127', startsAt: '2026-11-26T15:00:00+09:00', endsAt: '2026-11-26T15:30:00+09:00' });
const T2_SEND = tool('t2-mail-send', RUN_2, TURN_2 + 52, null, 'waiting', 'mail.send', {
  to: 'tanaka@example.co.jp',
  subject: '【変更】来週の定例は11/26(木)15時です',
  body: '田中さん\n\nお疲れさまです。来週の週次定例を、11/26(木) 15:00〜15:30 に変更しました。場所はこれまでどおり第2会議室です。\n\n議題は先月の請求の確認と、年末の予定のすり合わせです。資料は前日までに共有します。\n\nよろしくお願いします。',
});
const UPDATE_REQUEST = RuntimeRequestId.make('req-update-event');
const SEND_REQUEST = RuntimeRequestId.make('req-mail-send');
const T2_UPDATE_APPROVAL = approval('t2-approval-update', T2_UPDATE, UPDATE_REQUEST, TURN_2 + 51, WEEKLY);
const T2_SEND_APPROVAL = approval('t2-approval-send', T2_SEND, SEND_REQUEST, TURN_2 + 52);
/** What the answer writes once both writes are made: long enough to reach the composer on a phone. */
const T2_FINAL = [
  '週次定例を **11/26(木) 15:00〜15:30** に変更し、田中さんにメールでお知らせしました。',
  '',
  '## 変更したこと',
  '',
  '- カレンダー：週次定例を 11/27(金) 10:00 から 11/26(木) 15:00 に移しました。場所は第2会議室のままです。',
  '- メール：tanaka@example.co.jp に「【変更】来週の定例は11/26(木)15時です」を送りました。',
  '',
  '## 請求について',
  '',
  '株式会社ミナトの ¥88,000 は支払期日が 11/30 で、まだ支払われていません。経理の担当の方に、今週中に振込の予定を確かめておくと安心です。',
  '',
  'Gmail の読み取り権限が切れていたため、請求メールそのものは読めませんでした。設定 → Google 連携で再接続していただければ、次からはメールの添付も合わせて確認します。',
  '',
  '## 次にできること',
  '',
  '1. 定例の議題を Google ドキュメントにまとめる',
  '2. 未払いの請求について、取引先への確認メールの下書きを作る',
  '3. 年末の予定を一覧にして、空いている日を探す',
  '',
  'どれか進めましょうか。最後の行まで読めるよう、この答えは少し長めにしています。',
].join('\n');

/** The subagent's own conversation: what it was asked, the tools it called, and what it answered. */
const CHILD_RUN = RunId.make('run-chosa');
const childBase = (id: string, ordinal: number, status: Status) => ({ ...base(id, CHILD_RUN, TURN_2 + 14 + ordinal, TURN_2 + 15 + ordinal, status), threadId: CHILD_THREAD_ID, ordinal });
const CHILD_ITEMS: ReadonlyArray<TurnItem> = [
  { ...childBase('c-user', 0, 'completed'), type: 'user_message', messageId: MessageId.make('m-c-user'), text: '先月（10月）の請求メールと添付を Drive から探し、取引先・金額・期日・支払状態をまとめる。', attachments: [], inputIntent: 'turn_start', createdBy: 'user', creationSource: 'web' },
  { ...childBase('c-search', 1, 'completed'), type: 'dynamic_tool', toolName: 'drive.search', input: { query: '請求書 2026年10月' }, output: [{ name: '請求書_ミナト_202610.pdf' }, { name: '請求書_青葉_202610.pdf' }, { name: '請求書_北斗_202610.pdf' }] },
  { ...childBase('c-read-1', 2, 'completed'), type: 'dynamic_tool', toolName: 'drive.read', input: { fileId: 'drive-minato' }, output: '株式会社ミナト 請求金額 ¥88,000 支払期日 2026/11/30' },
  { ...childBase('c-read-2', 3, 'completed'), type: 'dynamic_tool', toolName: 'drive.read', input: { fileId: 'drive-aoba' }, output: '青葉デザイン 請求金額 ¥52,800 支払済 2026/11/15' },
  { ...childBase('c-answer', 4, 'completed'), type: 'assistant_message', messageId: MessageId.make('m-c-answer'), text: '10月分の請求は3件、合計 ¥184,800 です。\n\n- 株式会社ミナト ¥88,000（期日 11/30、**未払い**）\n- 青葉デザイン ¥52,800（11/15 支払済）\n- 北斗システム ¥44,000（11/10 支払済）', streaming: false },
];

/**
 * What each answer read and wrote, as the Worker records it after every model request. The first
 * answer read little of its conversation from the cache (there was hardly any before it); the
 * second read almost all of it again, and grows request by request while it is written.
 */
const CONTEXT_WINDOW = 200_000;
const RUN_1_USAGE: OrchestrationV2RunUsage = {
  requests: 2, inputTokens: 17_320, cachedInputTokens: 9_216, cacheWriteTokens: 7_404, outputTokens: 312,
  firstInputTokens: 8_420, firstCachedInputTokens: 1_024, contextTokens: 9_116, maxContextTokens: CONTEXT_WINDOW,
  costUsd: 0.0321, costBilled: false,
};
const RUN_2_FIRST = { firstInputTokens: 10_050, firstCachedInputTokens: 8_960, maxContextTokens: CONTEXT_WINDOW } as const;
/** The second answer's usage after its third, fourth, fifth, and sixth request. */
const RUN_2_USAGE: ReadonlyArray<OrchestrationV2RunUsage> = [
  { ...RUN_2_FIRST, requests: 3, inputTokens: 32_400, cachedInputTokens: 27_100, cacheWriteTokens: 3_210, outputTokens: 640, contextTokens: 12_180, costUsd: 0.0284, costBilled: false },
  { ...RUN_2_FIRST, requests: 4, inputTokens: 45_200, cachedInputTokens: 38_900, cacheWriteTokens: 4_120, outputTokens: 1_240, contextTokens: 13_420, costUsd: 0.0469, costBilled: false },
  { ...RUN_2_FIRST, requests: 5, inputTokens: 59_700, cachedInputTokens: 52_400, cacheWriteTokens: 5_330, outputTokens: 1_410, contextTokens: 14_050, costUsd: 0.0570, costBilled: false },
  { ...RUN_2_FIRST, requests: 6, inputTokens: 74_600, cachedInputTokens: 66_300, cacheWriteTokens: 6_910, outputTokens: 2_140, contextTokens: 16_240, costUsd: 0.0788, costBilled: false },
];
/** The subagent's own answer, on a model whose provider does not say how large its window is, nor its price. */
const CHILD_USAGE: OrchestrationV2RunUsage = {
  requests: 4, inputTokens: 21_800, cachedInputTokens: 14_200, cacheWriteTokens: 0, outputTokens: 860,
  firstInputTokens: 3_120, firstCachedInputTokens: 0, contextTokens: 6_940, maxContextTokens: null,
};
/** A short reply to a message sent in the sample: one request that reads most of the conversation so far again from the cache, priced as Claude Sonnet is. */
const replyUsage = (before: number, model: string | null): OrchestrationV2RunUsage => {
  const input = before + 180;
  const cached = Math.max(0, before - 420);
  return {
    requests: 1, inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: input - cached, outputTokens: 96,
    firstInputTokens: input, firstCachedInputTokens: cached, contextTokens: input + 96,
    // The sample's fast model is one whose provider does not say how large its window is, nor what it costs.
    maxContextTokens: model === 'fast-model' ? null : CONTEXT_WINDOW,
    ...(model === 'fast-model' ? {} : { costUsd: (cached * 0.3 + (input - cached) * 3.75 + 96 * 15) / 1_000_000, costBilled: false }),
  };
};

const run = (id: RunId, ordinal: number, user: string, start: DateTime.Utc, end: DateTime.Utc | null, status: OrchestrationV2Run['status'], usage?: OrchestrationV2RunUsage): OrchestrationV2Run => ({
  id,
  threadId: THREAD_ID,
  ordinal,
  providerInstanceId: PROVIDER,
  modelSelection: MODEL,
  providerThreadId: null,
  userMessageId: MessageId.make(user),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: start,
  startedAt: start,
  completedAt: end,
  checkpointId: null,
  contextHandoffId: null,
  ...(usage === undefined ? {} : { usage }),
});

const request = (id: RuntimeRequestId, second: number): OrchestrationV2RuntimeRequest => ({
  id,
  nodeId: NodeId.make('node-root'),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: 'permission',
  status: 'pending',
  responseCapability: { type: 'live', providerSessionId: ProviderSessionId.make('session-1'), supportsFeedback: true },
  createdAt: at(second),
  resolvedAt: null,
});

const snapshot = (items: ReadonlyArray<TurnItem>, threadId: ThreadId = THREAD_ID): OrchestrationV2ThreadProjection => ({
  thread: {
    id: threadId,
    projectId: ProjectId.make('flarechat'),
    title: '来週の定例と請求の確認',
    providerInstanceId: PROVIDER,
    modelSelection: MODEL,
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: threadId === THREAD_ID ? null : THREAD_ID, relationshipToParent: null },
    forkedFrom: null,
    createdBy: 'user',
    creationSource: 'web',
    createdAt: at(0),
    updatedAt: at(TURN_2 + 14),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [run(RUN_1, 1, 'm-t1-user', at(0), at(72), 'completed', RUN_1_USAGE), run(RUN_2, 2, 'm-t2-user', at(TURN_2), null, 'running', RUN_2_USAGE[0])],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: items,
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: items.map((item, position) => ({ position, visibility: 'local', sourceThreadId: threadId, sourceItemId: item.id, item })),
  updatedAt: at(TURN_2 + 14),
});

/** The subagent's conversation as a screen that opens it reads it, finished. */
const childSnapshot = (): OrchestrationV2ThreadProjection => {
  const projection = snapshot(CHILD_ITEMS, CHILD_THREAD_ID);
  return {
    ...projection,
    thread: { ...projection.thread, title: '先月の請求メールを調べる', runtimeMode: 'full-access' },
    runs: [{ ...run(CHILD_RUN, 1, 'm-c-user', at(TURN_2 + 14), at(TURN_2 + 41), 'completed', CHILD_USAGE), threadId: CHILD_THREAD_ID }],
  };
};

/** The sample continued from its first answer as a new conversation: that answer and the message it answered, under the fork's own id. */
const forkSnapshot = (): OrchestrationV2ThreadProjection => {
  const forkId = ThreadId.make(FAKE_FORK_ID);
  const items = [T1_USER, T1_REASONING, T1_TOOL, T1_ASSISTANT].map((entry) => ({ ...entry, threadId: forkId }));
  const projection = snapshot(items, forkId);
  return {
    ...projection,
    thread: { ...projection.thread, title: '来週の定例と請求の確認（続き）', lineage: { rootThreadId: forkId, parentThreadId: null, relationshipToParent: null }, updatedAt: now() },
    runs: [{ ...run(RUN_1, 1, 'm-t1-user', at(0), at(72), 'completed', RUN_1_USAGE), threadId: forkId }],
  };
};

/** The text `text` has shown after `step` of `steps` chunks. */
const prefix = (text: string, step: number, steps: number): string => text.slice(0, Math.ceil((text.length * step) / steps));

export interface FakeTransportOptions {
  /** Multiplies every delay; 0 plays the whole scenario at once. */
  readonly pace?: number;
}

/** A transport that plays the scenario for whoever subscribes, numbering every change. */
export const createFakeTransport = (options: FakeTransportOptions = {}): ChatTransport => {
  const pace = options.pace ?? 1;
  let sequence = 0;
  let sink: ((frame: string) => void) | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let nextRun = 3;
  let activeRun: { readonly id: RunId; readonly ordinal: number; readonly user: string; readonly start: DateTime.Utc } | null = null;
  const answered = new Set<string>();
  // Every run as last sent, so a rewind rolls back those from a message on; the sample's first two to begin with.
  const runs = new Map<string, OrchestrationV2Run>();
  // The member's message of each run sent after the sample's, by its message id.
  const sent = new Map<string, { readonly run: RunId; readonly ordinal: number }>();
  let chosen: string | null = null;

  const later = (ms: number, act: () => void): void => {
    timers.push(setTimeout(act, ms * pace));
  };
  const emit = (event: OrchestrationV2DomainEvent): void => {
    sink?.(encodeFrame({ kind: 'event', sequence, event }));
  };
  const next = (): { readonly id: EventId; readonly threadId: ThreadId; readonly occurredAt: DateTime.Utc } => {
    sequence += 1;
    return { id: EventId.make(`event-${sequence}`), threadId: THREAD_ID, occurredAt: now() };
  };
  const item = (payload: TurnItem): void => {
    const event: EventOf<'turn-item.updated'> = { ...next(), type: 'turn-item.updated', payload };
    emit(event);
  };
  const runUpdated = (payload: OrchestrationV2Run): void => {
    runs.set(payload.id, payload);
    const event: EventOf<'run.updated'> = { ...next(), type: 'run.updated', payload };
    emit(event);
  };
  const requestUpdated = (payload: OrchestrationV2RuntimeRequest): void => {
    const event: EventOf<'runtime-request.updated'> = { ...next(), type: 'runtime-request.updated', payload };
    emit(event);
  };
  const stream = (start: number, every: number, steps: number, full: AssistantItem): void => {
    for (let step = 1; step <= steps; step += 1) {
      const done = step === steps;
      later(start + step * every, () => item({ ...full, status: done ? 'completed' : 'running', streaming: !done, completedAt: done ? now() : null, text: prefix(full.text, step, steps) }));
    }
  };
  // The second answer's usage so far: one more request recorded at each step it takes.
  let run2Usage = 0;
  const run2 = (status: OrchestrationV2Run['status'], end: DateTime.Utc | null = null, request = false): void => {
    if (request) run2Usage = Math.min(run2Usage + 1, RUN_2_USAGE.length - 1);
    runUpdated(run(RUN_2, 2, 'm-t2-user', at(TURN_2), end, status, RUN_2_USAGE[run2Usage]));
  };
  /** How much the conversation holds after its latest answer, which the next one reads again. */
  const heldTokens = (): number => [...runs.values()]
    .filter((entry) => entry.status !== 'rolled_back')
    .toSorted((left, right) => right.ordinal - left.ordinal)
    .find((entry) => entry.usage !== undefined)?.usage?.contextTokens ?? 0;

  const play = (): void => {
    run2Usage = 0;
    const initial = [T1_USER, T1_REASONING, T1_TOOL, T1_ASSISTANT, T2_USER, T2_REASONING, { ...T2_FREE, status: 'running', completedAt: null, output: undefined }, T2_MAIL_SEARCH, T2_BROWSER_OPEN, { ...T2_BROWSER_READ, status: 'running', completedAt: null, output: undefined }, T2_SUBAGENT, T2_CHART, { ...T2_PDF, status: 'running', completedAt: null, output: undefined }] satisfies TurnItem[];
    sequence = 1;
    const opened = snapshot(initial);
    for (const entry of opened.runs) runs.set(entry.id, entry);
    sink?.(encodeFrame({ kind: 'snapshot', snapshotSequence: sequence, projection: opened }));
    sink?.(encodeFrame({ kind: 'synchronized' }));
    later(1200, () => {
      item(T2_FREE);
      item(T2_BROWSER_READ);
      item(T2_PDF);
    });
    stream(1800, 450, 8, T2_ASSISTANT);
    later(6500, () => {
      item(T2_UPDATE);
      item(T2_UPDATE_APPROVAL);
      requestUpdated(request(UPDATE_REQUEST, TURN_2 + 51));
      run2('waiting', null, true);
    });
  };

  const resolve = (approvalItem: ApprovalItem, toolItem: ToolItem, requestId: RuntimeRequestId, second: number, decision: ChatDecision): boolean => {
    requestUpdated({ ...request(requestId, second), status: 'resolved', resolvedAt: now(), decision });
    item({ ...approvalItem, status: 'completed', completedAt: now() });
    const allowed = decision !== 'decline' && decision !== 'cancel';
    item({ ...toolItem, status: allowed ? 'running' : 'cancelled', completedAt: allowed ? null : now() });
    return allowed;
  };

  const respond = async (requestId: string, decision: ChatDecision): Promise<void> => {
    if (answered.has(requestId)) return;
    answered.add(requestId);
    if (requestId === UPDATE_REQUEST) {
      later(300, () => {
        const allowed = resolve(T2_UPDATE_APPROVAL, T2_UPDATE, UPDATE_REQUEST, TURN_2 + 51, decision);
        run2('running');
        if (allowed) item({ ...T2_UPDATE, status: 'completed', completedAt: now(), output: { eventId: 'event-teirei-1127', changed: ['startsAt', 'endsAt'], keptOverrides: [], deleted: false } });
        item(T2_SEND);
        item(T2_SEND_APPROVAL);
        requestUpdated(request(SEND_REQUEST, TURN_2 + 52));
        run2('waiting', null, true);
      });
      return;
    }
    if (requestId !== SEND_REQUEST) return;
    later(300, () => {
      const allowed = resolve(T2_SEND_APPROVAL, T2_SEND, SEND_REQUEST, TURN_2 + 52, decision);
      run2('running');
      if (allowed) item({ ...T2_SEND, status: 'completed', completedAt: now(), output: { sent: true, to: 'tanaka@example.co.jp' } });
    });
    stream(600, 250, 8, { ...assistant('t2-assistant-2', RUN_2, TURN_2 + 60, TURN_2 + 70, T2_FINAL), startedAt: now() });
    later(2800, () => run2('completed', now(), true));
  };

  const send = async (text: string): Promise<void> => {
    const ordinal = nextRun;
    nextRun += 1;
    const id = RunId.make(`run-${ordinal}`);
    const second = TURN_2 + ordinal * 100;
    const user = `m-t${ordinal}-user`;
    activeRun = { id, ordinal, user, start: now() };
    const usage = replyUsage(heldTokens(), chosen);
    sent.set(user, { run: id, ordinal });
    item({ ...userMessage(`t${ordinal}-user`, id, second, text), startedAt: now(), completedAt: now(), updatedAt: now() });
    runUpdated(run(id, ordinal, user, activeRun.start, null, 'running'));
    const reply = assistant(`t${ordinal}-assistant`, id, second + 1, second + 2, `「${text}」を受け取りました。これは画面確認用のデモ会話なので、実際の予定やメールは変わりません。`);
    stream(400, 300, 5, { ...reply, startedAt: now() });
    later(2000, () => {
      if (activeRun?.id !== id) return;
      runUpdated(run(id, ordinal, user, activeRun.start, now(), 'completed', usage));
      activeRun = null;
    });
  };

  // The sample deployment holds no OpenRouter key, so, as the Worker then does, it offers no 自動.
  const modes = async (): Promise<ReadonlyArray<ChatMode>> => OFFERED_MODES;

  const setMode = async (mode: ChatMode): Promise<void> => {
    if (!OFFERED_MODES.includes(mode)) throw new Error('自動は選べません。この FlareChat には、自動で判定するための OpenRouter の鍵が設定されていません。');
    const event: OrchestrationV2DomainEvent = { ...next(), type: 'thread.metadata-updated', payload: { ...snapshot([]).thread, runtimeMode: runtimeModeOf(mode), updatedAt: now() } };
    emit(event);
  };

  const interrupt = async (): Promise<void> => {
    if (activeRun === null) return;
    runUpdated(run(activeRun.id, activeRun.ordinal, activeRun.user, activeRun.start, now(), 'interrupted'));
    activeRun = null;
  };

  const subscribe = (threadId: string, _afterSequence: number, onFrame: (frame: string) => void): (() => void) => {
    if (threadId === CHILD_THREAD_ID) {
      onFrame(encodeFrame({ kind: 'snapshot', snapshotSequence: 1, projection: childSnapshot() }));
      onFrame(encodeFrame({ kind: 'synchronized' }));
      return () => {};
    }
    if (threadId === FAKE_FORK_ID) {
      onFrame(encodeFrame({ kind: 'snapshot', snapshotSequence: 1, projection: forkSnapshot() }));
      onFrame(encodeFrame({ kind: 'synchronized' }));
      return () => {};
    }
    if (threadId !== FAKE_THREAD_ID) return () => {};
    sink = onFrame;
    play();
    return () => {
      sink = null;
      timers.forEach(clearTimeout);
      timers = [];
    };
  };

  /** Rolls back the answer the message began and every one after it, as the Worker does, and answers the message rewritten. */
  const rewind = async (messageId: string, text: string): Promise<void> => {
    if (activeRun !== null) throw new Error('答えを書いている間は編集し直せません。止めてからにしてください。');
    const target = messageId === 'm-t1-user' ? 1 : messageId === 'm-t2-user' ? 2 : sent.get(messageId)?.ordinal;
    if (target === undefined) throw new Error('このメッセージは編集し直せません。');
    for (const entry of [...runs.values()].toSorted((left, right) => left.ordinal - right.ordinal)) {
      if (entry.ordinal >= target && entry.status !== 'rolled_back') runUpdated({ ...entry, status: 'rolled_back' });
    }
    await send(text);
  };

  const fork = async (): Promise<string> => FAKE_FORK_ID;

  // The sample's Drive saves into a folder of its own after a moment, and its Picker hands over one file.
  const saveToDrive = async (fileId: string, choose: boolean): Promise<{ readonly url: string }> => {
    await new Promise((done) => setTimeout(done, 600 * pace));
    return { url: `https://drive.google.com/drive/folders/${choose ? 'chosen' : 'ai-ni-kiku'}?file=${encodeURIComponent(fileId)}` };
  };
  const pickDriveFiles = async (): Promise<ReadonlyArray<File>> =>
    [new File([pdfText(['Minutes, November 2026', 'Weekly meeting moved to Thursday 15:00'])], '11月の議事録.pdf', { type: 'application/pdf' })];

  // The sample conversation answers each message on its own, so nothing ever waits in its queue.
  const changeQueue = async (): Promise<void> => {
    throw new Error('この画面確認用の会話には、待っているメッセージはありません。');
  };

  // The sample suggests one reply after any answer that completed, as a member who keeps confirming would send.
  const suggestion = async (): Promise<ChatSuggestion> => {
    const latest = [...runs.values()].filter((entry) => entry.startedAt !== null).toSorted((left, right) => right.ordinal - left.ordinal)[0];
    return { runId: latest?.id ?? null, text: latest?.status === 'completed' ? 'その内容で進めてください' : null };
  };

  return {
    subscribe, respond, send, modes, setMode, interrupt, changeQueue, rewind, fork, saveToDrive, pickDriveFiles, suggestion,
    capabilities: async () => FAKE_CAPABILITIES,
    chosenModel: () => chosen,
    chooseModel: (model) => {
      chosen = model;
    },
    attachmentUrls: new Map([['att-seikyusho', IMAGE], ['att-chart', CHART], ['att-invoices', pdfUrl()]]),
  };
};
