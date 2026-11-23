/**
 * Conversations of the Operator Chat before ADR 0201 in every shape
 * production may hold them, for the tests of migration 0061, which copies
 * them into the chat built on t3code's. Each row is one a commit wrote:
 *
 * - `tools` '[]' on an exchange before 0051 and on one that never ended
 *   (7ff6be2 began writing `{ name, state, error? }`), an entry still
 *   `started`, entries the old chat passed over, text that is not JSON,
 *   and an object that is not an array.
 * - a completed exchange, a failed one with `response` null (f4e0ea8), one
 *   still running, one failed by 5b3bda3 as abandoned, one stopped with what
 *   it had written and the stop note as `error` (debe788), and a stopped
 *   transcription with `response` '' (76f92ca).
 * - a tree (4a44573): a message asked again beside another, a first message
 *   asked again (no parent), a parent the conversation does not hold, and a
 *   parent after its child, which with that child would be a loop.
 * - times '' as 0041 coalesced them, a blank title, an empty conversation.
 * - files (0039, 0043): a member's picture kept as an envelope (2f103c0), a
 *   member's file of a kind no longer accepted, a PDF whose bytes a message
 *   asked again shares (4a44573), an answer's workbook saved to Drive, an
 *   answer's file kept as an envelope (6700325), and an answer's files with
 *   no name or type, larger than a file may be, and a picture too large to
 *   show inline, and one whose id t3code would not take as an attachment's.
 */

export const ACCOUNT = 'organization-1';
export const STOPPED = '回答を途中で停止しました。';
export const INTERRUPTED = '答えを書き終える前に処理が止まりました。「やり直す」でもう一度聞けます。';
export const TABLE = '| 日付 | 予定 |\n| --- | --- |\n| 11/24 | 総会 |\n| 11/25 | 会費の締切 |';
/** A failure longer than an error item may carry, in characters that are two UTF-16 units each. */
export const LONG_ERROR = `失敗:${'😀'.repeat(3000)}`;

const run = (id: string, status: 'completed' | 'failed' | 'planning', model: string | null): string =>
  `INSERT INTO runs (id, trigger, execution_mode, status, model, started_at, updated_at) VALUES ('${id}', 'chat', 'unattended', '${status}', ${model === null ? 'NULL' : `'${model}'`}, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`;

interface Turn {
  id: string;
  conversation: string;
  parent: string | null;
  position: number;
  request: string;
  response: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  tools: string;
  created: string;
  updated: string;
  asker?: [string, string];
}

const quote = (value: string | null): string => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;

const turn = (row: Turn): string =>
  `INSERT INTO chat_turns (id, conversation_id, run_id, parent_turn_id, position, request, response, status, error, tools, asked_by_identity, asked_by_name, created_at, updated_at) VALUES (${[
    row.id, row.conversation, `run-${row.id}`, row.parent,
  ].map(quote).join(', ')}, ${row.position}, ${[row.request, row.response, row.status, row.error, row.tools, row.asker?.[0] ?? null, row.asker?.[1] ?? '', row.created, row.updated].map(quote).join(', ')})`;

interface Attachment {
  id: string;
  turn: string;
  position: number;
  filename: string;
  mediaType: string;
  size: number;
  key: string;
  origin: 'request' | 'response';
  drive?: string;
}

const attachment = (row: Attachment): string =>
  `INSERT INTO chat_attachments (id, turn_id, position, filename, media_type, size, object_key, origin, drive_file_id, drive_url, created_at) VALUES (${[
    row.id, row.turn,
  ].map(quote).join(', ')}, ${row.position}, ${[row.filename, row.mediaType].map(quote).join(', ')}, ${row.size}, ${[
    row.key, row.origin, row.drive ? 'drive-1' : null, row.drive ?? null, '2026-11-01T10:00:30.000Z',
  ].map(quote).join(', ')})`;

const TURNS: Turn[] = [
  // 週末の予定: a1 → a2 → a3 (stopped), a1 → b2 (failed, changed last), c1 (asked again from the start, never ended), d1 (its parent is gone), e1 → f1 (e1 names f1 as its parent).
  { id: 'a1', conversation: 'talk', parent: null, position: 1, request: '来週の予定を表にして', response: TABLE, status: 'completed', error: null, tools: '[]', created: '2026-11-01T10:00:00.000Z', updated: '2026-11-01T10:00:40.000Z', asker: ['identity-1', '山田'] },
  {
    id: 'a2', conversation: 'talk', parent: 'a1', position: 2, request: 'メールも見て', response: '2通ありました。表を作りました。', status: 'completed', error: null,
    tools: JSON.stringify([
      { name: 'mail.search', state: 'finished' },
      { name: 'drive.read', state: 'failed', error: 'GoogleApiError 403: 権限がありません' },
      'mail.read',
      42,
      { state: 'finished' },
      { name: '   ', state: 'finished' },
      { name: 'mail.read', state: 'paused' },
      { name: 'acme.lookup', state: 'failed', error: 7 },
    ]),
    created: '2026-11-01T10:01:00.000Z', updated: '2026-11-01T10:01:30.000Z',
  },
  { id: 'a3', conversation: 'talk', parent: 'a2', position: 3, request: '続けて', response: '途中まで書きました', status: 'completed', error: STOPPED, tools: '[{"name":"mail.read","state":"finished"}]', created: '2026-11-01T10:02:00.000Z', updated: '2026-11-01T10:03:00.000Z' },
  {
    id: 'b2', conversation: 'talk', parent: 'a1', position: 4, request: 'メールを調べて', response: null, status: 'failed', error: 'Gmail が混み合っています（429）。',
    tools: '[{"name":"mail.search","state":"failed","error":"GoogleApiError 429: Too many concurrent requests for user."},{"name":"mail.read","state":"started"}]',
    created: '2026-11-01T10:04:00.000Z', updated: '2026-11-01T10:05:00.000Z',
  },
  { id: 'c1', conversation: 'talk', parent: null, position: 5, request: '最初から聞き直す', response: null, status: 'running', error: null, tools: '[]', created: '', updated: '' },
  { id: 'd1', conversation: 'talk', parent: 'gone', position: 6, request: '前の続き', response: null, status: 'failed', error: INTERRUPTED, tools: '[]', created: '2026-11-01T09:00:00.000Z', updated: '2026-11-01T09:00:10.000Z' },
  { id: 'e1', conversation: 'talk', parent: 'f1', position: 7, request: '輪の始まり', response: 'はい', status: 'completed', error: null, tools: '[]', created: '2026-11-01T08:00:00.000Z', updated: '2026-11-01T08:00:10.000Z' },
  { id: 'f1', conversation: 'talk', parent: 'e1', position: 8, request: '輪の続き', response: 'はい', status: 'completed', error: null, tools: '[]', created: '2026-11-01T08:01:00.000Z', updated: '2026-11-01T08:01:10.000Z' },
  // A conversation with a blank title: m1 → m3, and m2 asked again from the start (a stopped transcription, changed last).
  { id: 'm1', conversation: 'misc', parent: null, position: 1, request: 'ファイルを作って\n二行目も', response: 'できました', status: 'completed', error: null, tools: 'not json', created: '2026-11-02T00:00:00.000Z', updated: '2026-11-02T00:00:10.000Z' },
  { id: 'm3', conversation: 'misc', parent: 'm1', position: 3, request: 'もう一度', response: null, status: 'failed', error: LONG_ERROR, tools: '{"name":"mail.search","state":"finished"}', created: '2026-11-02T00:02:00.000Z', updated: '2026-11-02T00:02:10.000Z' },
  { id: 'm2', conversation: 'misc', parent: null, position: 2, request: '録音を文字にして', response: '', status: 'completed', error: STOPPED, tools: '[{"name":"audio.transcribe","state":"failed","error":"回答を途中で停止しました。"}]', created: '2026-11-02T00:01:00.000Z', updated: '2026-11-02T00:05:00.000Z' },
];

const ATTACHMENTS: Attachment[] = [
  { id: 'att-photo', turn: 'a1', position: 1, filename: '写真.png', mediaType: 'image/png', size: 4, key: `chat-attachments/${ACCOUNT}/att-photo.json`, origin: 'request' },
  { id: 'att-zip', turn: 'a1', position: 2, filename: '古い.zip', mediaType: 'application/zip', size: 4, key: `chat-attachments/${ACCOUNT}/att-zip`, origin: 'request' },
  { id: 'att-sheet', turn: 'a2', position: 1, filename: '予定.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 5, key: `chat-attachments/${ACCOUNT}/att-sheet`, origin: 'response', drive: 'https://drive.google.com/file/d/drive-1' },
  { id: 'att-pdf', turn: 'm1', position: 1, filename: '資料.pdf', mediaType: 'application/pdf', size: 3, key: `chat-attachments/${ACCOUNT}/att-pdf`, origin: 'request' },
  { id: 'att-blank', turn: 'm1', position: 2, filename: '　', mediaType: '', size: 0, key: `chat-attachments/${ACCOUNT}/att-blank`, origin: 'response' },
  { id: 'att-video', turn: 'm1', position: 3, filename: '会議.mp4', mediaType: 'video/mp4', size: 60 * 1024 * 1024, key: `chat-attachments/${ACCOUNT}/att-video`, origin: 'response' },
  { id: 'att-poster', turn: 'm1', position: 4, filename: 'ポスター.png', mediaType: 'image/png', size: 11 * 1024 * 1024, key: `chat-attachments/${ACCOUNT}/att-poster`, origin: 'response' },
  { id: 'att-letter', turn: 'm1', position: 5, filename: '案内.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 6, key: `chat-attachments/${ACCOUNT}/att-letter.json`, origin: 'response' },
  { id: 'att odd/1', turn: 'b2', position: 1, filename: '請求書.pdf', mediaType: 'application/pdf', size: 9, key: `chat-attachments/${ACCOUNT}/att-odd`, origin: 'request' },
  { id: 'att-pdf-again', turn: 'm2', position: 1, filename: '資料.pdf', mediaType: 'application/pdf', size: 3, key: `chat-attachments/${ACCOUNT}/att-pdf`, origin: 'request' },
];

/** Every statement that puts the old chat's rows in place, in an order its foreign keys accept. */
export const LEGACY_CHAT: readonly string[] = [
  ...TURNS.map((row) => run(`run-${row.id}`, row.status === 'running' ? 'planning' : row.status, row.id === 'a1' ? 'claude-sonnet-4-5' : null)),
  `INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES
    ('talk', '${ACCOUNT}', '週末の予定', '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z'),
    ('misc', '${ACCOUNT}', '  ', '2026-11-02T00:00:00.000Z', '2026-11-02T00:05:00.000Z'),
    ('quiet', '${ACCOUNT}', '空の会話', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`,
  ...TURNS.map(turn),
  ...ATTACHMENTS.map(attachment),
];

/** The conversations the copy makes, each path's title by its id. */
export const COPIED_TITLES: Readonly<Record<string, string>> = {
  talk: '週末の予定',
  'talk-2': '週末の予定（別の枝 2）',
  'talk-3': '週末の予定（別の枝 3）',
  'talk-4': '週末の予定（別の枝 4）',
  'talk-5': '週末の予定（別の枝 5）',
  misc: '録音を文字にして',
  'misc-2': 'ファイルを作って 二行目も（別の枝 2）',
  quiet: '空の会話',
};

/** The exchanges each copied conversation holds, first to last. */
export const COPIED_PATHS: Readonly<Record<string, readonly string[]>> = {
  talk: ['a1', 'b2'],
  'talk-2': ['a1', 'a2', 'a3'],
  'talk-3': ['d1'],
  'talk-4': ['e1', 'f1'],
  'talk-5': ['c1'],
  misc: ['m2'],
  'misc-2': ['m1', 'm3'],
  quiet: [],
};
