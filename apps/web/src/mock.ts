import type {
  BrowserLogin,
  BrowserSettings,
  AccessToken,
  IssuedLoginCode,
  AuthorizationPreview,
  OperatorToken,
  AppState,
  SignedInPerson,
  AutomationStatus,
  AutomationWarning,
  ChannelTestTarget,
  ChatThread,
  GuestRegistrationRoster,
  McpServer,
  Memory,
  MemoryDetail,
  MemoryHit,
  StuckJob,
  ContactImportPreview,
} from '@mail/domain';
import { ContactCsvRefusal, readContactCsv, readSkillDocument, writeSkillDocument } from '@mail/domain';

import {
  ACCOUNT_ID,
  automation,
  connections,
  contact,
  contactList,
  dashboard,
  delivery,
  eventDetail,
  eventOverview,
  exception,
  lineHandle,
  run,
  skill,
  recording,
  transcript,
} from './screens/fixtures';

/**
 * A stand-in for the Worker's API, so every screen past sign-in can be seen
 * without a Google grant. `npm run dev:mock` serves it; nothing in
 * the application imports it.
 */

const identity = { email: 'owner@example.com', displayName: '運用担当' };

/** The Google accounts the mocked browser is signed in to, the current one first: each has an Account of its own. */
let people: SignedInPerson[] = [
  { identityId: 'identity-1', ...identity, account: { accountId: ACCOUNT_ID, name: 'サンプル町内会', status: 'active' } },
  { identityId: 'identity-2', email: 'bousai@example.com', displayName: '防災委員会', account: { accountId: 'org-2', name: '防災委員会', status: 'active' } },
];

const readyState = (): AppState => {
  const [current] = people;
  if (!current) return { kind: 'signed_out' };
  const signed = { identity: { email: current.email, displayName: current.displayName }, people };
  return current.account ? { kind: 'ready', ...signed, account: current.account } : { kind: 'unassigned', ...signed };
};

let state: AppState = readyState();

/** Whether the mocked Account has connected its mailbox. */
let mailbox = true;

/**
 * Where the mock starts: signed in with Accounts (the default), signed out,
 * signed in with no Account yet, or in an Account whose mailbox is not connected.
 */
export type MockEntry = 'ready' | 'signed_out' | 'unassigned' | 'no_mailbox';

export const startMockAt = (entry: MockEntry): void => {
  if (entry === 'signed_out') state = { kind: 'signed_out' };
  if (entry === 'unassigned') state = { kind: 'unassigned', identity, people: [{ identityId: 'identity-1', ...identity, account: null }] };
  if (entry === 'no_mailbox') mailbox = false;
};

const contacts = [
  contact({ id: 'contact-1', name: '山田 太郎', email: 'taro@example.com', description: '会計', tags: ['役員'], lineDestinations: [{ id: 'handle-2', destinationId: 'Uyamada', displayName: '山田', kind: 'user', status: 'discovered', source: 'webhook' }] }),
  contact({ id: 'contact-2', name: '佐藤 花子', email: 'hanako@example.com', description: '書記', tags: ['役員'] }),
  contact({ id: 'contact-3', name: '鈴木 一郎', email: '', description: '班長', tags: ['3班'], lineDestinations: [{ id: 'handle-3', destinationId: 'Usuzuki', displayName: 'いちろう', kind: 'user', status: 'discovered', source: 'webhook' }] }),
  contact({ id: 'contact-4', name: '役員グループ', email: '', description: 'LINE グループ', tags: [], lineDestinations: [] }),
  contact({ id: 'contact-5', name: '高橋 次郎', email: 'jiro@example.com', state: 'inactive', description: '前年度の会長', tags: [] }),
];

const automationStatus: AutomationStatus = {
  email: 'inbox@example.com',
  displayName: 'サンプル町内会',
  status: 'active',
  lastError: null,
  failingSince: null,
  draftsGranted: true,
  driveGranted: true,
  meetGranted: true,
  tasksGranted: true,
};

const upcomingEvents = [
  eventOverview({ id: 'event-1', title: '秋季総会', startsAt: '2026-10-20T01:00:00.000Z', endsAt: '2026-10-20T03:00:00.000Z', location: '市民会館 大会議室', responseDeadline: '2026-10-15', attending: 12, notAttending: 3, unanswered: 5, guestsAttending: 3 }),
  eventOverview({ id: 'event-2', title: '10月定例会', startsAt: '2026-10-22T10:00:00.000Z', endsAt: '2026-10-22T11:30:00.000Z', location: 'オンライン', responseDeadline: '2026-10-21', attending: 4, notAttending: 0, unanswered: 8, guestsAttending: 0, sourceSubject: '定例会のお知らせ' }),
  eventOverview({ id: 'event-3', title: '清掃活動', startsAt: '2026-11-03T00:00:00.000Z', endsAt: '2026-11-03T02:00:00.000Z', location: '中央公園', responseDeadline: null, attending: 0, notAttending: 0, unanswered: 0, guestsAttending: 0, sourceSubject: null }),
];

const pastEvents = [
  eventOverview({ id: 'event-0', title: '防災訓練', startsAt: '2026-09-28T00:30:00.000Z', endsAt: '2026-09-28T02:30:00.000Z', location: '第一小学校 体育館', responseDeadline: '2026-09-25', attending: 15, notAttending: 4, unanswered: 1, guestsAttending: 6 }),
];

const homeDashboard = dashboard({
  automations: [
    { id: 'automation-mail', name: '毎朝のメール処理', enabled: true, schedule: 'daily 05:00', nextRunAt: '2026-10-12T20:00:00.000Z', lastRun: { id: 'run-1', startedAt: '2026-10-11T20:00:00.000Z', status: 'completed', error: null } },
    { id: 'automation-weekly', name: '毎週の予定のお知らせ', enabled: true, schedule: 'weekly mon 08:00', nextRunAt: '2026-10-12T23:00:00.000Z', lastRun: { id: 'run-2', startedAt: '2026-10-05T23:00:00.000Z', status: 'failed', error: 'AI 接続が応答しませんでした。' } },
    { id: 'automation-reminders', name: 'タスクのリマインド', enabled: false, schedule: 'daily 07:00', nextRunAt: null, lastRun: null },
  ],
  attention: [
    { kind: 'pending_approval', count: 1, detail: '毎朝のメール処理' },
    { kind: 'failed_run', count: 1, detail: '毎週の予定のお知らせ' },
    { kind: 'unlinked_line', count: 1, detail: '役員グループ' },
  ],
  upcomingEvents: upcomingEvents.slice(0, 2),
});

const guestRegistrations: GuestRegistrationRoster[] = [{
  eventId: 'event-1',
  title: '秋季総会',
  startsAt: '2026-10-20T01:00:00.000Z',
  attendingCount: 3,
  affiliations: [{ affiliation: '東町内会', attending: 2 }, { affiliation: '西町内会', attending: 1 }],
  guests: [
    { name: '中村 誠', affiliation: '東町内会', attending: true },
    { name: '小林 恵', affiliation: '東町内会', attending: true },
    { name: '加藤 健', affiliation: '西町内会', attending: true },
  ],
}];

const warnings: AutomationWarning[] = [{
  id: 'warning-1', sourceMessageId: 'message-2', code: 'deadline_assumed',
  message: '回答期限が書かれていなかったため、開催日の3日前としました。', createdAt: '2026-10-11T20:10:00.000Z',
}];

const stuckJobs: StuckJob[] = [];

const mcpServers: McpServer[] = [
  { id: 'mcp-1', name: 'Notion', url: 'https://mcp.notion.example/sse', revision: '3', authentication: 'oauth', signInError: null, updatedAt: '2026-09-30T00:00:00.000Z' },
  { id: 'mcp-2', name: 'linear', url: 'https://mcp.linear.example/mcp', revision: null, authentication: 'oauth', signInError: 'サインインが切れました。もう一度サインインしてください。', updatedAt: '2026-09-30T00:00:00.000Z' },
  { id: 'mcp-3', name: 'line', url: 'https://mcp.line.example/mcp', revision: null, authentication: 'token', signInError: null, updatedAt: '2026-09-30T00:00:00.000Z' },
];

const browserLogins: BrowserLogin[] = [
  { id: 'login-1', site: 'www.example-shop.jp', url: 'https://www.example-shop.jp/login', signingIn: false, savedAt: '2026-10-08T01:00:00.000Z', usedAt: '2026-10-11T22:05:00.000Z' },
];

const accessTokens: AccessToken[] = [{
  id: 'token-1', name: '会計ソフト連携',
  lastUsedAt: '2026-10-10T03:00:00.000Z', tools: ['query_contacts'],
}];

const operatorTokens: OperatorToken[] = [{
  id: 'operator-1', email: 'owner@example.com', client: null, createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-12-30T00:00:00.000Z', lastUsedAt: '2026-10-11T02:00:00.000Z',
}, {
  id: 'operator-2', email: 'owner@example.com', client: 'Claude', createdAt: '2026-10-20T00:00:00.000Z',
  expiresAt: '2027-01-18T00:00:00.000Z', lastUsedAt: '2026-11-04T09:00:00.000Z',
}];

/** What the authorization screen is asked, as Claude asks it when it connects. */
const authorizationPreview = (): AuthorizationPreview => ({
  kind: 'ask',
  client: 'Claude',
  redirectHost: 'claude.ai',
  accounts: [{ accountId: 'organization-1', name: 'サンプル町内会', email: identity.email }],
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
});

const loginCode = (): IssuedLoginCode => ({
  code: 'K7QF-2M9X',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  exchangeUrl: 'https://orangeagent.example.workers.dev/api/public/organizations/organization-1/operator-tokens',
  serverUrl: 'https://orangeagent.example.workers.dev/api/public/organizations/organization-1/mcp',
});

/** Operator Chat's conversations (ADR 0201); each opens the sample conversation the page plays. */
let chatThreads: ChatThread[] = [
  { id: 'thread-teirei', title: '来週の定例と請求の確認', createdAt: '2026-11-21T00:55:00.000Z', updatedAt: '2026-11-21T01:00:00.000Z' },
  { id: 'thread-soukai', title: '', createdAt: '2026-11-19T08:00:00.000Z', updatedAt: '2026-11-19T08:00:00.000Z' },
];

const newChatThread = (): ChatThread => {
  const at = new Date().toISOString();
  const thread: ChatThread = { id: `thread-${Date.now()}`, title: '', createdAt: at, updatedAt: at };
  chatThreads = [thread, ...chatThreads];
  return thread;
};

/** Renaming a conversation keeps its place in the list; deleting it takes it out. */
const mockChatThreadChange = (method: string, written: string, body: unknown): MockResponse | null => {
  const threadId = /^\/chat-threads\/([^/]+)$/u.exec(written)?.[1];
  if (!threadId || (method !== 'PATCH' && method !== 'DELETE')) return null;
  const id = decodeURIComponent(threadId);
  const thread = chatThreads.find((entry) => entry.id === id) ?? { id, title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (method === 'DELETE') {
    chatThreads = chatThreads.filter((entry) => entry.id !== id);
    return { status: 200, body: { data: { id, deleted: true } } };
  }
  const title = typeof body === 'object' && body !== null && typeof (body as { title?: unknown }).title === 'string' ? (body as { title: string }).title.trim() : '';
  if (!title) return { status: 400, body: { error: { code: 'invalid', message: '会話の名前を入力してください。' } } };
  const renamed = { ...thread, title };
  chatThreads = chatThreads.map((entry) => entry.id === id ? renamed : entry);
  return { status: 200, body: { data: renamed } };
};

const channelTestTargets: ChannelTestTarget[] = contacts
  .filter((value) => value.state === 'active')
  .map((value) => ({ id: value.id, name: value.name, email: value.email, state: value.state, channels: [...(value.email ? ['email'] : []), ...(value.lineDestinations.length ? ['line'] : [])] }));

const automations = [
  automation({
    id: 'automation-mail', name: '毎朝のメール処理', schedule: 'daily 05:00', nextRunAt: '2026-10-12T20:00:00.000Z',
    tools: ['query_scheduled_events', 'query_contacts', 'query_attendance', 'mail.search', 'mail.read', 'calendar.search', 'drive.search', 'drive.read', 'tasks.search', 'tasks.create', 'tasks.update', 'channel.send', 'reminder.schedule', 'mail.send', 'create_scheduled_event', 'update_scheduled_event', 'cancel_scheduled_event', 'attach_event_files', 'record_event_response'],
    suppressionWindow: 'none',
    lastRun: { id: 'run-1', startedAt: '2026-10-11T20:00:00.000Z', status: 'completed', error: null },
  }),
  automation({
    id: 'automation-reminders', name: 'タスクのリマインド', enabled: false, schedule: 'daily 07:00', nextRunAt: null, skillIds: ['prompt-3'],
    tools: ['tasks.search', 'query_contacts', 'channel.send', 'mail.send'],
  }),
  automation({
    id: 'automation-weekly', name: '毎週の予定のお知らせ', schedule: 'weekly mon 08:00', nextRunAt: '2026-10-12T23:00:00.000Z', skillIds: ['prompt-2'],
    tools: ['query_scheduled_events', 'query_contacts', 'channel.send'],
    lastRun: { id: 'run-2', startedAt: '2026-10-05T23:00:00.000Z', status: 'failed', error: 'AI 接続が応答しませんでした。' },
  }),
];

const runs = [
  run({
    id: 'run-1',
    writes: [
      { id: 'write-1', key: 'create_scheduled_event:0', tool: 'create_scheduled_event', arguments: { title: '秋季総会', startsAt: '2026-10-20T19:00:00+09:00', attendees: ['taro@example.com', 'hanako@example.com'] }, dependsOn: [], status: 'pending', attempts: 0, result: null, error: null },
      { id: 'write-2', key: 'channel.send:1', tool: 'channel.send', arguments: { channel: 'line', contactId: 'contact-4', text: '【予定】\n・10/20(火) 10:00 秋季総会（市民会館）' }, dependsOn: [], status: 'pending', attempts: 0, result: null, error: null },
    ],
  }),
  run({ id: 'run-2', trigger: 'schedule', automation: { id: 'automation-weekly', name: '毎週の予定のお知らせ', revision: 1 }, sourceMessage: null, executionMode: 'unattended', status: 'failed', output: null, error: 'AI 接続が応答しませんでした。', transcript: false }),
];

/** Each GET the screens read, by its path below `/api/organizations/:accountId`. */
/** The Skills' directories, each file as its bytes, so the mocked スキル screen can open and change them. */
const skillFolders = new Map<string, { name: string; title: string; description: string; files: Map<string, { mediaType: string; bytes: Uint8Array }> }>();

const textFile = (content: string, mediaType = 'text/markdown') => ({ mediaType, bytes: new TextEncoder().encode(content) });
const skillDocument = (name: string, title: string, description: string, instructions: string): string => writeSkillDocument({ name, title, description, instructions });

for (const [id, name, title, description, instructions, files] of [
  ['prompt-1', 'mail-intake', 'メールの取り込み', '届いたメールを読んで、予定とタスクを整え、送信先にまとめを知らせるとき。', '前回この自動化が動いてから届いたメールを読み、予定とタスクを整えて、送信先にまとめを知らせてください。\n\n送信先: 要約送信グループ', []],
  ['prompt-2', 'weekly-events', '毎週の予定', '今週の予定を知らせるとき。', '今週の予定を、役員グループ（LINE）に 1 通で知らせてください。書き方は examples/notice.md の見本に合わせ、assets/header.png を添えます。', [
    ['examples/notice.md', textFile('【今週の予定】\n・10/14（火）19:00 役員会（公民館）\n・10/18（土）9:00 清掃活動（集合: 公園）\n\nご都合の悪い方は返信でお知らせください。')],
    ['assets/header.png', { mediaType: 'image/png', bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0)) }],
  ]],
  ['prompt-3', 'task-reminder', 'タスクのリマインド', '期限が近い・過ぎたタスクを、担当者に知らせるとき。', '未完了のタスクのうち、今日が期限の 7 日前、3 日前、当日、期限を過ぎた次の日に当たるものを、その担当者に知らせてください。', []],
] as const) {
  skillFolders.set(id, { name, title, description, files: new Map([['SKILL.md', textFile(skillDocument(name, title, description, instructions))], ...files]) });
}

const mockSkills = () => [...skillFolders.entries()].map(([id, folder]) => skill({
  id, name: folder.name, title: folder.title, description: folder.description,
  files: [...folder.files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, file]) => ({ path, size: file.bytes.byteLength, mediaType: file.mediaType })),
}));

/** One file of a mocked Skill's folder, as the Worker serves it. */
export const mockSkillFile = (pathname: string, search: string): { mediaType: string; bytes: Uint8Array } | null => {
  const skillId = /^\/api\/organizations\/[^/]+\/skills\/([^/]+)\/file$/u.exec(pathname)?.[1];
  if (!skillId) return null;
  return skillFolders.get(decodeURIComponent(skillId))?.files.get(new URLSearchParams(search).get('path') ?? '') ?? null;
};

/** Writes one file of a mocked Skill as the Worker would; SKILL.md names the Skill. */
const writeMockFile = (skillId: string, path: string, file: { mediaType: string; bytes: Uint8Array }) => {
  const folder = skillFolders.get(skillId) ?? { name: 'skill', title: 'スキル', description: '', files: new Map() };
  folder.files.set(path, file);
  if (path === 'SKILL.md') {
    const read = readSkillDocument(new TextDecoder().decode(file.bytes));
    folder.name = read.name || 'skill';
    folder.title = read.title || folder.name;
    folder.description = read.description ?? '';
  }
  skillFolders.set(skillId, folder);
  return mockSkills().find((candidate) => candidate.id === skillId);
};

/** Answers a change of a mocked Skill's directory: making one, writing, deleting, or moving a file. */
const mockSkillChange = (method: string, written: string, body: unknown, search: string, mediaType: string): MockResponse | null => {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array();
  const file = { mediaType: mediaType || 'application/octet-stream', bytes };
  if (method === 'POST' && written === '/skills') return { status: 201, body: { data: writeMockFile(`skill-${Date.now()}`, 'SKILL.md', { ...file, mediaType: 'text/markdown' }) } };
  const skillId = decodeURIComponent(/^\/skills\/([^/]+)\/(?:file|move)$/u.exec(written)?.[1] ?? '');
  const folder = skillFolders.get(skillId);
  if (!folder) return null;
  const path = new URLSearchParams(search).get('path') ?? '';
  if (method === 'PUT' && written.endsWith('/file')) return { status: 200, body: { data: writeMockFile(skillId, path, file) } };
  if (method === 'DELETE' && written.endsWith('/file')) {
    folder.files.delete(path);
    return { status: 200, body: { data: mockSkills().find((candidate) => candidate.id === skillId) } };
  }
  if (method === 'POST' && written.endsWith('/move')) {
    const { from = '', to = '' } = (body ?? {}) as { from?: string; to?: string };
    for (const [kept, content] of [...folder.files.entries()]) {
      if (kept !== from && !kept.startsWith(`${from}/`)) continue;
      folder.files.delete(kept);
      folder.files.set(`${to}${kept.slice(from.length)}`, content);
    }
    return { status: 200, body: { data: mockSkills().find((candidate) => candidate.id === skillId) } };
  }
  return null;
};

/** The mocked Memory: kept while the page is open, searched by the characters a memory shares with what is asked. */
const mockMemories: Memory[] = [
  {
    id: 'memory-1', content: '田中さんへの連絡はメールではなく LINE で送る', author: { kind: 'chat', name: '', conversationId: 'conversation-1' },
    editedBy: null, status: 'active', kind: 'fact', provenance: 'proposed', createdAt: '2026-10-28T01:10:00.000Z', updatedAt: '2026-10-28T01:10:00.000Z',
  },
  {
    id: 'memory-2', content: '総会の資料は A4 縦・明朝体で作り、PDF にして役員グループに送る', author: { kind: 'person', name: 'Owner', conversationId: null },
    editedBy: null, status: 'active', kind: 'fact', provenance: 'member', createdAt: '2026-10-30T03:00:00.000Z', updatedAt: '2026-10-30T03:00:00.000Z',
  },
  {
    id: 'memory-3', content: '会費の振込先は町内会名義の口座（ゆうちょ）', author: { kind: 'cli', name: 'Owner', conversationId: null },
    editedBy: 'Owner', status: 'active', kind: 'fact', provenance: 'member', createdAt: '2026-11-01T05:00:00.000Z', updatedAt: '2026-11-02T00:30:00.000Z',
  },
];

const mockPairs = (text: string): Set<string> => {
  const letters = [...text.replace(/\s+/gu, '').toLowerCase()];
  return new Set(letters.map((letter, index) => `${letter}${letters[index + 1] ?? ''}`));
};

/** The share of the query's character pairs a memory holds, standing in for the keyword index. */
const mockKeywords = (query: string, content: string): number => {
  const asked = mockPairs(query);
  const held = mockPairs(content);
  return asked.size ? [...asked].filter((pair) => held.has(pair)).length / asked.size : 0;
};

/** How near two texts are in the mock: the share of character pairs they hold in common, standing in for Workers AI. */
const mockNearness = (query: string, content: string): number => {
  const pairs = mockPairs;
  const asked = pairs(query);
  const held = pairs(content);
  const shared = [...asked].filter((pair) => held.has(pair)).length;
  return asked.size && held.size ? shared / Math.sqrt(asked.size * held.size) : 0;
};

/** Answers a change or a search of the mocked Memory. */
const mockMemoryChange = (method: string, written: string, body: unknown): MockResponse | null => {
  const sent = (body ?? {}) as { content?: unknown; query?: unknown };
  const now = new Date().toISOString();
  if (method === 'POST' && written === '/memories/search') {
    const query = typeof sent.query === 'string' ? sent.query.trim() : '';
    if (!query) return { status: 400, body: { error: { code: 'invalid', message: '探すことを入力してください。' } } };
    const round = (value: number): number => Math.round(value * 100) / 100;
    const hits: MemoryHit[] = mockMemories
      .map((memory) => {
        const keywords = round(mockKeywords(query, memory.content));
        return { memory, similarity: round(0.35 + 0.6 * mockNearness(query, memory.content)), keywords: keywords > 0 ? keywords : null };
      })
      .filter((hit) => (hit.similarity ?? 0) > 0.5 || (hit.keywords ?? 0) >= 0.6)
      .sort((left, right) => (right.similarity ?? 0) + (right.keywords ?? 0) - (left.similarity ?? 0) - (left.keywords ?? 0))
      .slice(0, 10);
    return { status: 200, body: { data: { query, hits } } };
  }
  const content = typeof sent.content === 'string' ? sent.content.trim() : '';
  if (method === 'POST' && written === '/memories') {
    if (!content) return { status: 400, body: { error: { code: 'invalid', message: '覚えることを入力してください。' } } };
    const kept = mockMemories.find((memory) => memory.content.replace(/\s+/gu, '') === content.replace(/\s+/gu, ''));
    if (kept) return { status: 201, body: { data: kept } };
    const memory: Memory = {
      id: `memory-${Date.now()}`, content, author: { kind: 'person', name: 'Owner', conversationId: null }, editedBy: null,
      status: 'active', kind: 'fact', provenance: 'member', createdAt: now, updatedAt: now,
    };
    mockMemories.unshift(memory);
    return { status: 201, body: { data: memory } };
  }
  const memoryId = decodeURIComponent(/^\/memories\/([^/]+)$/u.exec(written)?.[1] ?? '');
  const index = mockMemories.findIndex((memory) => memory.id === memoryId);
  if (!memoryId) return null;
  if (index < 0) return { status: 404, body: { error: { code: 'not_found', message: 'この記憶は見つかりません。すでに削除されたかもしれません。' } } };
  if (method === 'PUT') {
    if (!content) return { status: 400, body: { error: { code: 'invalid', message: '覚えることを入力してください。' } } };
    const [before] = mockMemories.splice(index, 1);
    const memory: Memory = { ...before as Memory, content, editedBy: 'Owner', provenance: 'member', updatedAt: now };
    mockMemories.unshift(memory);
    return { status: 200, body: { data: memory } };
  }
  if (method === 'DELETE') {
    mockMemories.splice(index, 1);
    return { status: 200, body: { data: { id: memoryId, removed: true } } };
  }
  return null;
};

/** Why the mock remembers a memory: the words it rests on, as a member or an AI said them, and its history. */
const mockMemoryDetail = (memoryId: string): MemoryDetail | null => {
  const memory = mockMemories.find((candidate) => candidate.id === memoryId);
  if (!memory) return null;
  // Until Episodes are read out of exchanges, a memory rests on an Episode of its own words.
  const said = memory.content;
  const start = 0;
  return {
    memory,
    episode: {
      source: memory.author.kind === 'chat' ? 'legacy' : memory.editedBy ? 'person' : memory.author.kind,
      memberName: memory.author.name,
      content: said,
      evidence: { start, end: start + memory.content.length },
      conversationId: memory.author.conversationId,
      receivedAt: memory.createdAt,
    },
    changes: [
      { at: memory.createdAt, actor: { kind: memory.author.kind === 'person' ? 'member' : memory.author.kind, name: memory.author.name }, action: 'add' },
      ...(memory.editedBy ? [{ at: memory.updatedAt, actor: { kind: 'member' as const, name: memory.editedBy }, action: 'correct' }] : []),
    ],
  };
};

const accountReads: ReadonlyArray<readonly [RegExp, (path: string) => unknown]> = [
  [/^\/automation$/u, () => mailbox ? automationStatus : null],
  [/^\/dashboard$/u, () => homeDashboard],
  [/^\/events\?view=past$/u, () => pastEvents],
  [/^\/events$/u, () => upcomingEvents],
  [/^\/events\/[^/?]+$/u, () => eventDetail({ ...upcomingEvents[0] })],
  [/^\/guest-registrations$/u, () => guestRegistrations],
  [/^\/skills$/u, () => mockSkills()],
  [/^\/memories$/u, () => ({ memories: mockMemories })],
  [/^\/browser$/u, () => mockBrowser()],
  [/^\/memories\/[^/]+$/u, (path) => mockMemoryDetail(decodeURIComponent(path.slice('/memories/'.length)))],
  [/^\/runs(\?.*)?$/u, (path) => runs.filter((entry) => !path.includes('automationId=') || path.endsWith(`automationId=${entry.automation?.id ?? ''}`))],
  [/^\/runs\/[^/]+\/transcript$/u, () => transcript()],
  [/^\/operations\/exceptions$/u, () => [exception({ message: 'AI 接続が応答しなかったため、このメールを保留しています。', createdAt: '2026-10-11T20:08:00.000Z' })]],
  [/^\/automation-warnings$/u, () => warnings],
  [/^\/operations\/jobs$/u, () => stuckJobs],
  [/^\/audit\/deliveries$/u, () => [
    delivery({ id: 'delivery-1', channel: 'line', destination: 'Uyamada', createdAt: '2026-10-11T20:15:00.000Z' }),
    delivery({ id: 'delivery-2', channel: 'email', destination: 'hanako@example.com', createdAt: '2026-10-11T20:15:00.000Z' }),
    delivery({ id: 'delivery-3', channel: 'line', destination: 'Cgroup', outcome: 'failed', createdAt: '2026-10-11T20:15:00.000Z' }),
  ]],
  [/^\/connections$/u, () => ({
    ...connections({
      ai: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], provider: 'anthropic' },
      transcription: { apiKeyConfigured: true, model: 'microsoft/mai-transcribe-2' },
    }),
    accountName: 'サンプル町内会',
  })],
  [/^\/transcripts$/u, () => ({ transcripts: mockTranscripts.map(({ lines: _lines, minutes: _minutes, minutesError: _error, minutesModel: _model, minutesInstructions: _instructions, ...summary }) => summary), transcription: true, minutes: true })],
  [/^\/transcripts\/[^/]+$/u, (path) => mockTranscripts.find((entry) => path.endsWith(`/${entry.id}`)) ?? mockTranscripts[0]],
  [/^\/drive-folders$/u, () => ({ folders: [{ id: 'folder-reikai', name: '2026-27 例会', url: 'https://drive.google.com/drive/folders/folder-reikai' }] })],
  [/^\/members$/u, () => contacts],
  [/^\/line-destinations$/u, () => [
    lineHandle({ id: 'handle-2', destinationId: 'Uyamada', displayName: '山田', contactId: 'contact-1' }),
    lineHandle({ id: 'handle-3', destinationId: 'Usuzuki', displayName: 'いちろう', contactId: 'contact-3' }),
    lineHandle({ id: 'handle-9', destinationId: 'Cgroup', displayName: '役員グループ', kind: 'group', contactId: null }),
  ]],
  [/^\/channel-tests\/targets$/u, () => channelTestTargets],
  [/^\/contact-lists$/u, () => [contactList({ id: 'list-1', name: '役員', contactIds: ['contact-1', 'contact-2'] }), contactList({ id: 'list-2', name: '3班', contactIds: ['contact-3'] })]],
  [/^\/mcp-servers$/u, () => mcpServers],
  [/^\/chat-threads$/u, () => chatThreads],
  // The mocked chat plays its own conversation (thread.tsx), whose transport says what it offers; this is what the Worker would.
  [/^\/chat-capabilities$/u, () => ({ models: ['standard-model', 'fast-model', 'reasoning-model'], efforts: { 'standard-model': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }, 'reasoning-model': { levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: null } }, drivePicker: true })],
  // The mock can notify; whether this browser can is the device's, which the mock plays (screens/chat.tsx).
  [/^\/push$/u, () => ({ publicKey: 'BMockPublicKeyOfTheMockedOrangeAgentForItsNotificationsOnly' })],
  [/^\/access-tokens$/u, () => accessTokens],
  [/^\/operator-tokens$/u, () => operatorTokens],
  [/^\/mcp-endpoint$/u, () => ({ url: 'https://orangeagent.example.workers.dev/api/public/organizations/organization-1/mcp' })],
  [/^\/automations$/u, () => automations],
  [/^\/automations\/[^/?]+$/u, (path) => automations.find((entry) => path === `/automations/${entry.id}`) ?? automations[0]],
];

const reads: ReadonlyArray<readonly [RegExp, (path: string) => unknown]> = [
  [/^\/api\/bootstrap$/u, () => state],
  [/^\/api\/presets$/u, () => []],
];

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Three recordings: one with minutes, one transcribed only, and one OpenRouter refused. */
const mockTranscripts = [
  recording({
    minutesState: 'completed',
    minutesModel: 'claude-sonnet-5-5',
    minutes: '## 概要\n10月の役員会。議題は秋祭りの準備と会費の集め方。\n\n## 議題と議論\n### 秋祭りの準備\n- テントは公民館から6張り借りられる（話者2）。\n- 設営の人手が足りない（話者3）。\n\n### 会費の集め方\n- 来年度からの口座振替を銀行に相談する（話者2）。\n\n## 決定事項\n- 設営は各班から2人ずつ出す。\n\n## 宿題・次のアクション\n- 班長は設営に出る人の名前を10月20日までに伝える。\n- 話者2：口座振替について銀行に確認する。',
  }),
  recording({ id: 'transcript-2', title: '9月の総会.mp3', filename: '9月の総会.mp3', mediaType: 'audio/mpeg', speakers: 4, durationSeconds: 4_020, createdAt: '2026-09-20T09:00:00.000Z' }),
  recording({ id: 'transcript-3', title: '防災訓練の打ち合わせ.wav', filename: '防災訓練の打ち合わせ.wav', mediaType: 'audio/wav', state: 'failed', error: 'OpenRouter が文字起こしできませんでした（microsoft/mai-transcribe-2）: Insufficient credits', lines: [], speakers: null, durationSeconds: null, createdAt: '2026-09-02T09:00:00.000Z' }),
];

/** The mock's answer to one request: the data a GET reads, or the body a write sent, echoed back. */
/** Writes whose answer is not the body they sent: adding an Automation, and trying one. */
const accountWrites: ReadonlyArray<readonly [RegExp, () => unknown]> = [
  // An upload is shown being transcribed; its page then reads the mock's transcribed recording.
  [/^\/transcripts$/u, () => ({ ...mockTranscripts[0], state: 'transcribing', durationSeconds: null, speakers: null })],
  [/^\/transcripts\/[^/]+\/minutes$/u, () => ({ ...mockTranscripts[1], minutesState: 'writing' })],
  [/^\/transcripts\/[^/]+\/transcribe$/u, () => ({ ...mockTranscripts[2], state: 'transcribing', error: null })],
  [/^\/chat-threads$/u, newChatThread],
  [/^\/push\/devices$/u, () => ({ subscribed: true })],
  // The mock has no Microsoft to send anyone to, so connecting lands straight back as connected.
  [/^\/connections\/microsoft\/authorize$/u, () => ({ authorizationUrl: '?microsoft=connected' })],
  // Nor an MCP Server's authorization server, so signing in lands straight back as signed in.
  [/^\/mcp-servers\/[^/]+\/authorize$/u, () => ({ authorizationUrl: '?mcp=connected' })],
  [/^\/automations$/u, () => automations[1]],
  // The mock has no Browser Run, so the Live View it hands out opens nothing real.
  [/^\/browser\/logins$/u, () => ({ login: { id: 'login-2', site: 'example.com', url: 'https://example.com/login', signingIn: true, savedAt: null, usedAt: null }, liveViewUrl: 'about:blank', expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() })],
  [/^\/browser\/logins\/[^/]+\/save$/u, () => ({ ...browserLogins[0], savedAt: new Date().toISOString() })],
  [/^\/login-codes$/u, loginCode],
  [/^\/automations\/[^/]+\/trial$/u, () => ({
    automation: { id: 'automation-mail', revision: 1 },
    model: 'claude-sonnet-5-5',
    output: '前回から届いたメール 2 通を読み、10/20 の総会の予定を作り、出欠の締め切りをタスクにしました。役員グループにまとめを送ります。',
    toolCalls: 7,
    tokens: 9_820,
    error: null,
    planned: [
      { tool: 'create_scheduled_event', arguments: { title: '秋季総会', startsAt: '2026-10-20T19:00:00+09:00', endsAt: '2026-10-20T21:00:00+09:00', messageId: 'gmail-message-1', attachments: [{ messageId: 'gmail-message-1', filename: '総会資料.pdf' }] } },
      { tool: 'tasks.create', arguments: { title: '総会の出欠を返信する', due: '2026-10-15', notes: '担当: 山田 太郎' } },
      { tool: 'channel.send', arguments: { channel: 'line', contactId: 'contact-4', text: '【予定】\n・10/20(火) 19:00 秋季総会\n【タスク】\n・10/15 総会の出欠を返信する' } },
    ],
  })],
];

/** The mock reads a Contact CSV as the Worker does, skipping a row whose email a Contact already holds. */
const mockContactImport = (written: string, body: unknown): MockResponse | null => {
  const importing = /^\/members\/import(\/preview)?$/u.exec(written);
  if (!importing) return null;
  const csv = typeof body === 'object' && body !== null && typeof (body as { csv?: unknown }).csv === 'string' ? (body as { csv: string }).csv : '';
  try {
    const { rows, problems } = readContactCsv(csv);
    const preview: ContactImportPreview = { accepted: [], skipped: [], invalid: problems };
    for (const row of rows) {
      const holder = row.email ? contacts.find((entry) => entry.email === row.email) : undefined;
      if (holder) preview.skipped.push({ line: row.line, name: row.name, email: row.email, reason: `このメールアドレスは既に「${holder.name}」に登録されています。` });
      else preview.accepted.push(row);
    }
    return { status: 200, body: { data: importing[1] ? preview : { ...preview, imported: preview.accepted.length } } };
  } catch (error) {
    if (!(error instanceof ContactCsvRefusal)) throw error;
    return { status: 400, body: { error: { code: 'invalid', message: error.message } } };
  }
};

let browserEnabled = false;
let browserTimeZone: string | null = null;

const mockBrowser = (): BrowserSettings => ({ enabled: browserEnabled, available: true, timeZone: browserTimeZone, logins: browserLogins });

/** Turning the Browser on sets its zone to this browser's when none is set; the ブラウザ screen sets any zone. */
const mockBrowserChange = (method: string, written: string, body: unknown): MockResponse | null => {
  if (method !== 'PUT' || (written !== '/browser' && written !== '/browser/time-zone')) return null;
  const input = typeof body === 'object' && body !== null ? body as { enabled?: unknown; timeZone?: unknown } : {};
  const zone = typeof input.timeZone === 'string' && input.timeZone ? input.timeZone : null;
  if (written === '/browser/time-zone') {
    if (!zone) return { status: 400, body: { error: { code: 'invalid', message: 'タイムゾーンを選んでください。' } } };
    browserTimeZone = zone;
  } else {
    browserEnabled = input.enabled === true;
    browserTimeZone ??= zone;
  }
  return { status: 200, body: { data: mockBrowser() } };
};

/** The mock's answer to one request; a file sent as its bytes arrives as a Uint8Array under its media type. */
export const mockResponse = (method: string, pathname: string, body: unknown, search = '', mediaType = ''): MockResponse => {
  const written = /^\/api\/organizations\/[^/]+(\/.*)$/u.exec(pathname)?.[1];
  const skillChange = written !== undefined && method !== 'GET' ? mockSkillChange(method, written, body, search, mediaType) : null;
  if (skillChange) return skillChange;
  const memoryChange = written !== undefined && method !== 'GET' ? mockMemoryChange(method, written, body) : null;
  if (memoryChange) return memoryChange;
  const browserChange = written !== undefined ? mockBrowserChange(method, written, body) : null;
  if (browserChange) return browserChange;
  const threadChange = written !== undefined ? mockChatThreadChange(method, written, body) : null;
  if (threadChange) return threadChange;
  const contactImport = written !== undefined && method === 'POST' ? mockContactImport(written, body) : null;
  if (contactImport) return contactImport;
  const answer = method === 'POST' && written !== undefined ? accountWrites.find(([pattern]) => pattern.test(written))?.[1] : undefined;
  if (answer) return { status: 200, body: { data: answer() } };
  if (method === 'POST' && pathname === '/api/auth/switch') {
    const identityId = typeof body === 'object' && body !== null ? (body as { identityId?: unknown }).identityId : undefined;
    people = [...people.filter((person) => person.identityId === identityId), ...people.filter((person) => person.identityId !== identityId)];
    state = readyState();
    return { status: 200, body: { data: { switched: true } } };
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const input = typeof body === 'object' && body !== null ? body as { identityId?: unknown; everyone?: unknown } : {};
    const leaving = input.everyone === true ? null : input.identityId ?? people[0]?.identityId;
    people = leaving === null ? [] : people.filter((person) => person.identityId !== leaving);
    state = readyState();
    return { status: 200, body: { data: { loggedOut: true, remaining: people.length } } };
  }
  if (method === 'POST' && pathname === '/api/oauth/authorizations/preview') return { status: 200, body: { data: authorizationPreview() } };
  if (method === 'POST' && pathname === '/api/oauth/authorizations') {
    const approved = typeof body === 'object' && body !== null && (body as { approve?: unknown }).approve === true;
    return { status: 200, body: { data: { location: approved ? 'https://claude.ai/api/mcp/auth_callback?code=mock&state=mock' : 'https://claude.ai/api/mcp/auth_callback?error=access_denied' } } };
  }
  if (method !== 'GET') return { status: 200, body: { data: { ok: true, ...(typeof body === 'object' && body !== null ? body : {}) } } };
  const accountPath = /^\/api\/organizations\/[^/]+(\/.*)$/u.exec(pathname)?.[1];
  const table = accountPath === undefined ? reads : accountReads;
  const path = `${accountPath ?? pathname}${search}`;
  const read = table.find(([pattern]) => pattern.test(path))?.[1];
  return read
    ? { status: 200, body: { data: read(path) } }
    : { status: 404, body: { error: { code: 'not_found', message: `モックに ${pathname} の応答がありません。` } } };
};
