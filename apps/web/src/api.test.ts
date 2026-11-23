// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  AccessToken,
  AuthorizationPreview,
  ChannelTestDelivery,
  ChannelTestTarget,
  TranscriptDetail,
  TranscriptSummary,
  ChatThread,
  ContactImportPreview,
  ContactPage,
  GuestRegistrationRoster,
  IssuedAccessToken,
  IssuedLoginCode,
  McpServer,
  McpServerTool,
  Memory,
  MemoryDetail,
  OperatorToken,
  Preset,
  StuckJob,
  AutomationWarning,
} from '@mail/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from './api';
import { ApiError, api, type Api } from './api';
import { setupPhaseLabel } from './entry';
import { browserZone } from './time';
import {
  ACCOUNT_ID,
  automation,
  automationStatus,
  connections,
  contact,
  contactList,
  dashboard,
  delivery,
  eventDetail,
  eventOverview,
  exception,
  lineHandle,
  ready,
  run,
  skill,
  transcript,
} from './screens/fixtures';

/*
 * Every screen test mocks `./api`, so this file is the one place a wrong
 * method, path, query, header or body in the GUI's HTTP client is caught.
 * Each row's expectation is written from the Worker's Hono route and the body
 * fields that route reads, never from api.ts, and each row names that route so
 * the test below can check it is still one the Worker declares.
 */

type Method = keyof Api;
type Result<K extends Method> = Awaited<ReturnType<Api[K]>>;
type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A file part or body as the Worker reads it: its name (for a part), its media type, and its bytes as text. */
interface SentFile {
  name?: string;
  type: string;
  text: string;
}

type SentBody =
  | { json: unknown }
  | { file: SentFile }
  | { form: Array<[string, string | SentFile]> };

/** What the Worker route receives. */
interface Sent {
  method: Verb;
  path: string;
  /** The query string, read as the Worker's `query(name)` reads it; absent means none at all. */
  query?: Record<string, string>;
  /** Absent means no body is sent. */
  body?: SentBody;
  /** Headers checked exactly; null means the header must not be sent. */
  headers?: Record<string, string | null>;
}

/** A method answered with the Worker's JSON envelope `{ data }`. */
interface JsonRow<K extends Method> {
  kind: 'json';
  /** The Worker's route, `VERB /path`, as mounted in apps/worker/src/app.ts. */
  route: string;
  call: (client: Api) => ReturnType<Api[K]>;
  sends: Sent;
  status?: 201;
  /** The Worker's answer, typed as the method returns it, so it satisfies the domain view. */
  data: Result<K>;
}

/** A method answered with something other than JSON: a file, or an event stream. */
interface RawRow<K extends Method> {
  kind: 'raw';
  route: string;
  call: (client: Api) => ReturnType<Api[K]>;
  sends: Sent;
  reply: () => Response;
  /** Calls the method against `reply` and checks what it resolved to. */
  run: (client: Api) => Promise<void>;
}

/** A method that only builds an address the browser opens itself, with the session cookie. */
interface UrlRow<K extends Method> {
  kind: 'url';
  route: string;
  call: (client: Api) => ReturnType<Api[K]> & string;
  url: string;
}

type Row<K extends Method> = JsonRow<K> | RawRow<K> | UrlRow<K>;

const A = ACCOUNT_ID;
const AT = '2026-09-01T00:00:00.000Z';

const preset: Preset = { id: 'preset-1', name: '町内会', description: '総会と回覧の自動化' };
const memory: Memory = {
  id: 'memory-1',
  content: '総会は毎年9月に開く',
  author: { kind: 'person', name: 'Owner', conversationId: null },
  editedBy: null,
  status: 'active',
  kind: 'fact',
  provenance: 'member',
  createdAt: AT,
  updatedAt: AT,
};
const memoryDetail: MemoryDetail = {
  memory,
  episode: { source: 'person', memberName: 'Owner', content: '総会は毎年9月に開く', evidence: { start: 0, end: 2 }, conversationId: null, receivedAt: AT },
  changes: [{ at: AT, actor: { kind: 'member', name: 'Owner' }, action: 'saved' }],
};
const roster: GuestRegistrationRoster = {
  eventId: 'event-1', title: '秋季総会', startsAt: AT, attendingCount: 1,
  affiliations: [{ affiliation: '東町内会', attending: 1 }],
  guests: [{ name: '中村 誠', affiliation: '東町内会', attending: true }],
};
const warning: AutomationWarning = { id: 'warning-1', sourceMessageId: 'message-1', code: 'unreadable', message: '添付を読めませんでした。', createdAt: AT };
const stuck: StuckJob = { id: 'job-1', kind: 'mail', state: 'claimed', attempts: 3, availableAt: AT, lastError: null, updatedAt: AT };
const preview: ContactImportPreview = {
  accepted: [{ line: 2, name: '山田 太郎', email: 'taro@example.com', description: '会計', tags: ['2026'] }],
  skipped: [{ line: 3, name: '佐藤 花子', email: 'hanako@example.com', reason: '既に名簿にあります' }],
  invalid: [{ line: 4, text: ',,', reason: '名前がありません' }],
};
const target: ChannelTestTarget = { id: 'contact-1', name: '山田 太郎', email: 'taro@example.com', state: 'active', channels: ['line', 'email'] };
const channelDelivery: ChannelTestDelivery = {
  delivered: true, channel: 'line', contactId: 'contact-1', destination: 'Uabc1', messages: 2, requests: 1, externalId: null, sentAt: AT,
};
const server: McpServer = { id: 'server-1', name: 'line', url: 'https://mcp.example/line', revision: null, authentication: 'token', signInError: null, updatedAt: AT };
const serverTool: McpServerTool = { name: 'push', description: 'Sends a message', inputSchema: { type: 'object' } };
const chatThread: ChatThread = { id: 'thread-1', title: '', createdAt: AT, updatedAt: AT };
const transcriptSummary: TranscriptSummary = {
  id: 'transcript-1', title: '総会.mp3', filename: '総会.mp3', mediaType: 'audio/mpeg', size: 2048, state: 'completed', error: null,
  durationSeconds: 3600, model: 'microsoft/mai-transcribe-2', speakers: 2, minutesState: null, createdBy: '管理者', createdAt: AT, updatedAt: AT,
};
const transcriptDetail: TranscriptDetail = {
  ...transcriptSummary, lines: [{ at: 0.5, speaker: '話者1', text: '開会します。' }], minutes: null, minutesError: null, minutesModel: null, minutesInstructions: '',
};
const accessToken: AccessToken = { id: 'token-1', name: 'Agent', lastUsedAt: null, tools: ['send_message'] };
const issuedToken: IssuedAccessToken = { id: 'token-1', name: 'Agent', tools: ['send_message'], token: 'secret', url: 'https://orangeagent.example/api/public/organizations/org-1/mcp' };
const operatorToken: OperatorToken = { id: 'operator-1', email: 'owner@example.com', client: 'Claude', createdAt: AT, expiresAt: AT, lastUsedAt: null };
const loginCode: IssuedLoginCode = {
  code: 'ABCD-EFGH', expiresAt: AT,
  exchangeUrl: 'https://orangeagent.example/api/public/organizations/org-1/operator-tokens',
  serverUrl: 'https://orangeagent.example/api/public/organizations/org-1/mcp',
};
const askPreview: AuthorizationPreview = {
  kind: 'ask', client: 'Claude', redirectHost: 'claude.ai', accounts: [{ accountId: A, name: 'Example', email: 'owner@example.com' }], expiresAt: AT,
};
const contactPage: ContactPage = {
  account: { accountId: A, name: 'Example' },
  contact: { contactId: 'contact-1', name: '山田 太郎' },
  events: [{
    eventId: 'event-1', title: '秋季総会', startsAt: AT, endsAt: AT, location: '市民会館', registrationDeadline: null, status: 'attending', comment: '', open: true,
  }],
};

/** Every exported client method, keyed by name; the type makes a missing or stray method a compile error. */
const table: { [K in Method]: Row<K> } = {
  bootstrap: {
    kind: 'json', route: 'GET /api/bootstrap', call: (c) => c.bootstrap(),
    sends: { method: 'GET', path: '/api/bootstrap' }, data: ready,
  },
  // Reads `returnTo`; answers 201.
  beginGoogleLogin: {
    kind: 'json', route: 'POST /api/entry/google', call: (c) => c.beginGoogleLogin('/tasks?status=open'),
    sends: { method: 'POST', path: '/api/entry/google', body: { json: { returnTo: '/tasks?status=open' } } },
    status: 201, data: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=1' },
  },
  previewAuthorization: {
    kind: 'json', route: 'POST /api/oauth/authorizations/preview', call: (c) => c.previewAuthorization('client_id=c&state=s'),
    sends: { method: 'POST', path: '/api/oauth/authorizations/preview', body: { json: { query: 'client_id=c&state=s' } } },
    data: askPreview,
  },
  // Reads `query`, `accountId`, and `approve === true`.
  decideAuthorization: {
    kind: 'json', route: 'POST /api/oauth/authorizations', call: (c) => c.decideAuthorization('client_id=c', A, true),
    sends: { method: 'POST', path: '/api/oauth/authorizations', body: { json: { query: 'client_id=c', accountId: A, approve: true } } },
    data: { location: 'https://claude.ai/callback?code=1' },
  },
  // Reads `identityId` and `everyone === true`.
  logout: {
    kind: 'json', route: 'POST /api/auth/logout', call: (c) => c.logout({ identityId: 'identity-2' }),
    sends: { method: 'POST', path: '/api/auth/logout', body: { json: { identityId: 'identity-2' } } },
    data: { loggedOut: true, remaining: 1 },
  },
  switchPerson: {
    kind: 'json', route: 'POST /api/auth/switch', call: (c) => c.switchPerson('identity-2'),
    sends: { method: 'POST', path: '/api/auth/switch', body: { json: { identityId: 'identity-2' } } },
    data: { switched: true },
  },
  presets: {
    kind: 'json', route: 'GET /api/presets', call: (c) => c.presets(),
    sends: { method: 'GET', path: '/api/presets' }, data: [preset],
  },
  // Reads no body.
  startAccount: {
    kind: 'json', route: 'POST /api/onboarding/start', call: (c) => c.startAccount(),
    sends: { method: 'POST', path: '/api/onboarding/start', body: { json: {} } }, data: { accepted: true },
  },
  retryOnboarding: {
    kind: 'json', route: 'POST /api/onboarding/retry', call: (c) => c.retryOnboarding(),
    sends: { method: 'POST', path: '/api/onboarding/retry' }, data: { accepted: true },
  },
  cancelOnboarding: {
    kind: 'json', route: 'DELETE /api/onboarding', call: (c) => c.cancelOnboarding(),
    sends: { method: 'DELETE', path: '/api/onboarding' }, data: { cancelled: true },
  },

  // Reads no body; answers 201.
  joinContactPage: {
    kind: 'json', route: 'POST /api/member-links/:accountId/:token', call: (c) => c.joinContactPage(A, 'tok/en'),
    sends: { method: 'POST', path: '/api/member-links/org-1/tok%2Fen', body: { json: {} } },
    status: 201, data: { contactId: 'contact-1', name: '山田 太郎' },
  },
  contactPage: {
    kind: 'json', route: 'GET /api/portal', call: (c) => c.contactPage(),
    sends: { method: 'GET', path: '/api/portal' }, data: contactPage,
  },
  // Reads `status` and `comment`.
  registerContactAttendance: {
    kind: 'json', route: 'PUT /api/portal/events/:eventId/attendance',
    call: (c) => c.registerContactAttendance('event 1', { status: 'not_attending', comment: '出張のため' }),
    sends: { method: 'PUT', path: '/api/portal/events/event%201/attendance', body: { json: { status: 'not_attending', comment: '出張のため' } } },
    data: { eventId: 'event 1' },
  },

  currentAutomation: {
    kind: 'json', route: 'GET /api/organizations/:accountId/automation', call: (c) => c.currentAutomation(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/automation' }, data: automationStatus(),
  },
  reauthorizeAutomationInbox: {
    kind: 'json', route: 'POST /api/organizations/:accountId/automation/reauthorize', call: (c) => c.reauthorizeAutomationInbox(A),
    sends: { method: 'POST', path: '/api/organizations/org-1/automation/reauthorize' },
    status: 201, data: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=2' },
  },
  dashboard: {
    kind: 'json', route: 'GET /api/organizations/:accountId/dashboard', call: (c) => c.dashboard(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/dashboard' }, data: dashboard(),
  },
  guestRegistrations: {
    kind: 'json', route: 'GET /api/organizations/:accountId/guest-registrations', call: (c) => c.guestRegistrations(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/guest-registrations' }, data: [roster],
  },
  // Reads `view === 'past'`; any other view is upcoming.
  events: {
    kind: 'json', route: 'GET /api/organizations/:accountId/events', call: (c) => c.events(A, 'past'),
    sends: { method: 'GET', path: '/api/organizations/org-1/events', query: { view: 'past' } }, data: [eventOverview()],
  },
  event: {
    kind: 'json', route: 'GET /api/organizations/:accountId/events/:eventId', call: (c) => c.event(A, 'event/1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/events/event%2F1' }, data: eventDetail(),
  },

  skills: {
    kind: 'json', route: 'GET /api/organizations/:accountId/skills', call: (c) => c.skills(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/skills' }, data: [skill()],
  },
  // Reads the body as the SKILL.md's bytes (`{ body: 'file' }`); answers 201.
  createSkill: {
    kind: 'json', route: 'POST /api/organizations/:accountId/skills',
    call: (c) => c.createSkill(A, new Blob(['---\nname: 朝の確認\n---\n'], { type: 'text/markdown' })),
    sends: { method: 'POST', path: '/api/organizations/org-1/skills', body: { file: { type: 'text/markdown', text: '---\nname: 朝の確認\n---\n' } } },
    status: 201, data: skill(),
  },
  // Reads `?path=`, the body as bytes, and the Content-Type as the media type.
  writeSkillFile: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/skills/:skillId/file',
    call: (c) => c.writeSkillFile(A, 'skill/1', 'examples/報告 1.md', new Blob(['# 報告'])),
    sends: {
      method: 'PUT', path: '/api/organizations/org-1/skills/skill%2F1/file', query: { path: 'examples/報告 1.md' },
      body: { file: { type: 'application/octet-stream', text: '# 報告' } },
    },
    data: skill(),
  },
  removeSkillFile: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/skills/:skillId/file', call: (c) => c.removeSkillFile(A, 'skill-1', 'a&b.md'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/skills/skill-1/file', query: { path: 'a&b.md' } }, data: skill(),
  },
  // Reads `from` and `to`.
  moveSkillFiles: {
    kind: 'json', route: 'POST /api/organizations/:accountId/skills/:skillId/move',
    call: (c) => c.moveSkillFiles(A, 'skill-1', { from: 'examples', to: 'samples' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/skills/skill-1/move', body: { json: { from: 'examples', to: 'samples' } } },
    data: skill(),
  },
  skillFileUrl: {
    kind: 'url', route: 'GET /api/organizations/:accountId/skills/:skillId/file',
    call: (c) => c.skillFileUrl(A, 'skill-1', 'images/図 1.png'),
    url: `/api/organizations/org-1/skills/skill-1/file?path=${encodeURIComponent('images/図 1.png')}`,
  },
  skillFile: {
    kind: 'raw', route: 'GET /api/organizations/:accountId/skills/:skillId/file',
    call: (c) => c.skillFile(A, 'skill-1', 'images/a.png'),
    sends: { method: 'GET', path: '/api/organizations/org-1/skills/skill-1/file', query: { path: 'images/a.png' }, headers: { 'content-type': null } },
    reply: () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } }),
    run: async (c) => {
      const file = await c.skillFile(A, 'skill-1', 'images/a.png');
      expect(file.type).toBe('image/png');
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
  },
  memories: {
    kind: 'json', route: 'GET /api/organizations/:accountId/memories', call: (c) => c.memories(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/memories' }, data: { memories: [memory] },
  },
  // Reads `query` from the body, never the address.
  searchMemories: {
    kind: 'json', route: 'POST /api/organizations/:accountId/memories/search', call: (c) => c.searchMemories(A, '総会 いつ'),
    sends: { method: 'POST', path: '/api/organizations/org-1/memories/search', body: { json: { query: '総会 いつ' } } },
    data: { query: '総会 いつ', hits: [{ memory, similarity: 0.82, keywords: null }] },
  },
  memory: {
    kind: 'json', route: 'GET /api/organizations/:accountId/memories/:memoryId', call: (c) => c.memory(A, 'memory-1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/memories/memory-1' }, data: memoryDetail,
  },
  // Reads `content`; answers 201.
  saveMemory: {
    kind: 'json', route: 'POST /api/organizations/:accountId/memories', call: (c) => c.saveMemory(A, '総会は毎年9月に開く'),
    sends: { method: 'POST', path: '/api/organizations/org-1/memories', body: { json: { content: '総会は毎年9月に開く' } } },
    status: 201, data: memory,
  },
  updateMemory: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/memories/:memoryId', call: (c) => c.updateMemory(A, 'memory-1', '総会は毎年10月に開く'),
    sends: { method: 'PUT', path: '/api/organizations/org-1/memories/memory-1', body: { json: { content: '総会は毎年10月に開く' } } },
    data: { ...memory, content: '総会は毎年10月に開く', editedBy: 'Owner' },
  },
  eraseMemory: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/memories/:memoryId', call: (c) => c.eraseMemory(A, 'memory-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/memories/memory-1' }, data: { id: 'memory-1', removed: true },
  },
  removeSkill: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/skills/:skillId', call: (c) => c.removeSkill(A, 'skill-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/skills/skill-1' }, data: { id: 'skill-1', removed: true },
  },
  // Reads `conflictPolicy`, absent or 'duplicate'; answers 201.
  applyPreset: {
    kind: 'json', route: 'POST /api/organizations/:accountId/presets/:presetId/apply', call: (c) => c.applyPreset(A, 'preset-1', 'duplicate'),
    sends: { method: 'POST', path: '/api/organizations/org-1/presets/preset-1/apply', body: { json: { conflictPolicy: 'duplicate' } } },
    status: 201, data: { presetId: 'preset-1', skills: 2, automations: 1 },
  },

  exceptions: {
    kind: 'json', route: 'GET /api/organizations/:accountId/operations/exceptions', call: (c) => c.exceptions(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/operations/exceptions' }, data: [exception()],
  },
  // Reads `action`, 'resolve' or 'retry'; anything else is refused as unsupported.
  resolveException: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/operations/exceptions/:exceptionId', call: (c) => c.resolveException(A, 'exception-1'),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/operations/exceptions/exception-1', body: { json: { action: 'resolve' } } },
    data: { id: 'exception-1' },
  },
  warnings: {
    kind: 'json', route: 'GET /api/organizations/:accountId/automation-warnings', call: (c) => c.warnings(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/automation-warnings' }, data: [warning],
  },
  stuckJobs: {
    kind: 'json', route: 'GET /api/organizations/:accountId/operations/jobs', call: (c) => c.stuckJobs(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/operations/jobs' }, data: [stuck],
  },
  // Reads `suspended`, a boolean.
  setSuspension: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/suspension', call: (c) => c.setSuspension(A, true),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/suspension', body: { json: { suspended: true } } },
    data: { accountId: A, status: 'suspended' },
  },
  deliveries: {
    kind: 'json', route: 'GET /api/organizations/:accountId/audit/deliveries', call: (c) => c.deliveries(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/audit/deliveries' }, data: [delivery()],
  },


  connections: {
    kind: 'json', route: 'GET /api/organizations/:accountId/connections', call: (c) => c.connections(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/connections' }, data: connections(),
  },
  // Reads `channelAccessToken` and `channelSecret`, each kept when left out.
  saveLineConnection: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/connections/line',
    call: (c) => c.saveLineConnection(A, { channelAccessToken: 'access', channelSecret: 'secret' }),
    sends: { method: 'PUT', path: '/api/organizations/org-1/connections/line', body: { json: { channelAccessToken: 'access', channelSecret: 'secret' } } },
    data: connections().line,
  },
  // Reads `provider` (one of the four), `apiKey`, `model`, and `models` (an array of names); the Base URL is the provider's own.
  saveAiConnection: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/connections/ai',
    call: (c) => c.saveAiConnection(A, { provider: 'anthropic', apiKey: 'key', model: 'claude-sonnet', models: ['claude-haiku'] }),
    sends: {
      method: 'PUT', path: '/api/organizations/org-1/connections/ai',
      body: { json: { provider: 'anthropic', apiKey: 'key', model: 'claude-sonnet', models: ['claude-haiku'] } },
    },
    data: { apiKeyConfigured: true, model: 'claude-sonnet', models: ['claude-sonnet', 'claude-haiku'], provider: 'anthropic' },
  },
  // Reads `apiKey` and `model`; a key left out keeps the one saved before.
  saveTranscriptionConnection: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/connections/transcription',
    call: (c) => c.saveTranscriptionConnection(A, { apiKey: 'sk-or-key', model: 'microsoft/mai-transcribe-2' }),
    sends: {
      method: 'PUT', path: '/api/organizations/org-1/connections/transcription',
      body: { json: { apiKey: 'sk-or-key', model: 'microsoft/mai-transcribe-2' } },
    },
    data: { apiKeyConfigured: true, model: 'microsoft/mai-transcribe-2' },
  },
  removeTranscriptionConnection: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/connections/transcription', call: (c) => c.removeTranscriptionConnection(A),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/connections/transcription' }, data: { apiKeyConfigured: false, model: '' },
  },
  connectMicrosoft: {
    kind: 'json', route: 'POST /api/organizations/:accountId/connections/microsoft/authorize', call: (c) => c.connectMicrosoft(A),
    sends: { method: 'POST', path: '/api/organizations/org-1/connections/microsoft/authorize' },
    data: { authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=3' },
  },
  disconnectMicrosoft: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/connections/microsoft', call: (c) => c.disconnectMicrosoft(A),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/connections/microsoft' }, data: { configured: true, connected: false, email: null },
  },
  // Reads `prompt`.
  testAiConnection: {
    kind: 'json', route: 'POST /api/organizations/:accountId/connections/ai/test', call: (c) => c.testAiConnection(A, 'こんにちは'),
    sends: { method: 'POST', path: '/api/organizations/org-1/connections/ai/test', body: { json: { prompt: 'こんにちは' } } },
    data: { text: 'こんにちは。', model: 'claude-sonnet' },
  },
  // Reads `botToken` and `applicationPublicKey`.
  saveDiscordConnection: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/connections/discord',
    call: (c) => c.saveDiscordConnection(A, { botToken: 'bot', applicationPublicKey: 'a'.repeat(64) }),
    sends: { method: 'PUT', path: '/api/organizations/org-1/connections/discord', body: { json: { botToken: 'bot', applicationPublicKey: 'a'.repeat(64) } } },
    data: { configured: true, interactionsUrl: 'https://orangeagent.example/api/public/organizations/org-1/discord/interactions' },
  },
  driveFolders: {
    kind: 'json', route: 'GET /api/organizations/:accountId/drive-folders', call: (c) => c.driveFolders(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/drive-folders' },
    data: { folders: [{ id: 'folder-1', name: '総会', url: 'https://drive.google.com/drive/folders/folder-1' }] },
  },
  // Reads `link`.
  addDriveFolder: {
    kind: 'json', route: 'POST /api/organizations/:accountId/drive-folders',
    call: (c) => c.addDriveFolder(A, 'https://drive.google.com/drive/folders/folder-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/drive-folders', body: { json: { link: 'https://drive.google.com/drive/folders/folder-1' } } },
    data: { folders: [{ id: 'folder-1', name: '総会', url: 'https://drive.google.com/drive/folders/folder-1' }] },
  },
  removeDriveFolder: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/drive-folders/:folderId', call: (c) => c.removeDriveFolder(A, 'folder-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/drive-folders/folder-1' }, data: { folders: [] },
  },
  browserSettings: {
    kind: 'json', route: 'GET /api/organizations/:accountId/browser', call: (c) => c.browserSettings(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/browser' }, data: { enabled: true, available: true, timeZone: null, logins: [] },
  },
  // Reads `enabled` and the zone this browser is in.
  setBrowserEnabled: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/browser', call: (c) => c.setBrowserEnabled(A, false),
    sends: { method: 'PUT', path: '/api/organizations/org-1/browser', body: { json: { enabled: false, timeZone: browserZone() } } }, data: { enabled: false, available: true, timeZone: 'Asia/Tokyo', logins: [] },
  },
  // Reads `timeZone`.
  setBrowserTimeZone: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/browser/time-zone', call: (c) => c.setBrowserTimeZone(A, 'Europe/London'),
    sends: { method: 'PUT', path: '/api/organizations/org-1/browser/time-zone', body: { json: { timeZone: 'Europe/London' } } }, data: { enabled: true, available: true, timeZone: 'Europe/London', logins: [] },
  },
  // Reads `url` and the zone this browser is in.
  beginBrowserSignIn: {
    kind: 'json', route: 'POST /api/organizations/:accountId/browser/logins', call: (c) => c.beginBrowserSignIn(A, 'https://example.com/login'),
    sends: { method: 'POST', path: '/api/organizations/org-1/browser/logins', body: { json: { url: 'https://example.com/login', timeZone: browserZone() } } },
    data: { login: { id: 'login-1', site: 'example.com', url: 'https://example.com/login', signingIn: true, savedAt: null, usedAt: null }, liveViewUrl: 'https://live.browser.run/view/1', expiresAt: '2026-11-21T01:20:00.000Z' },
  },
  saveBrowserSignIn: {
    kind: 'json', route: 'POST /api/organizations/:accountId/browser/logins/:loginId/save', call: (c) => c.saveBrowserSignIn(A, 'login-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/browser/logins/login-1/save', body: { json: {} } },
    data: { id: 'login-1', site: 'example.com', url: 'https://example.com/login', signingIn: false, savedAt: '2026-11-21T01:00:00.000Z', usedAt: null },
  },
  cancelBrowserSignIn: {
    kind: 'json', route: 'POST /api/organizations/:accountId/browser/logins/:loginId/cancel', call: (c) => c.cancelBrowserSignIn(A, 'login-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/browser/logins/login-1/cancel', body: { json: {} } }, data: { id: 'login-1', cancelled: true },
  },
  removeBrowserLogin: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/browser/logins/:loginId', call: (c) => c.removeBrowserLogin(A, 'login-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/browser/logins/login-1' }, data: { id: 'login-1', deleted: true },
  },

  contacts: {
    kind: 'json', route: 'GET /api/organizations/:accountId/members', call: (c) => c.contacts(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/members' }, data: [contact()],
  },
  // Reads `name`, `email`, `description`, `tags`, `lineDestinationId`; answers 201.
  createContact: {
    kind: 'json', route: 'POST /api/organizations/:accountId/members',
    call: (c) => c.createContact(A, { name: '山田 太郎', email: 'taro@example.com', description: '会計', tags: ['2026'], lineDestinationId: 'handle-1' }),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/members',
      body: { json: { name: '山田 太郎', email: 'taro@example.com', description: '会計', tags: ['2026'], lineDestinationId: 'handle-1' } },
    },
    status: 201, data: contact(),
  },
  // Reads `name`, `email`, `description`, `tags`, `state`.
  updateContact: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/members/:contactId',
    call: (c) => c.updateContact(A, 'contact-1', { state: 'inactive', tags: [] }),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/members/contact-1', body: { json: { state: 'inactive', tags: [] } } },
    data: { id: 'contact-1', state: 'inactive', tags: [] },
  },
  deleteContact: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/members/:contactId', call: (c) => c.deleteContact(A, 'contact-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/members/contact-1' }, data: { id: 'contact-1', removed: true },
  },
  // Reads `destinationId`, `kind`, `displayName`; answers 201 for a new handle.
  setContactLineHandle: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/members/:contactId/line-destination',
    call: (c) => c.setContactLineHandle(A, 'contact-1', { destinationId: `U${'0'.repeat(32)}`, kind: 'user', displayName: '太郎' }),
    sends: {
      method: 'PUT', path: '/api/organizations/org-1/members/contact-1/line-destination',
      body: { json: { destinationId: `U${'0'.repeat(32)}`, kind: 'user', displayName: '太郎' } },
    },
    status: 201, data: { id: 'handle-1', destinationId: 'U000…0000', displayName: '太郎', kind: 'user', status: 'discovered', source: 'manual' },
  },
  removeContactLineHandle: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/members/:contactId/line-destination/:lineDestinationId',
    call: (c) => c.removeContactLineHandle(A, 'contact-1', 'handle-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/members/contact-1/line-destination/handle-1' },
    data: { id: 'handle-1', unlinked: true },
  },
  lineHandles: {
    kind: 'json', route: 'GET /api/organizations/:accountId/line-destinations', call: (c) => c.lineHandles(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/line-destinations' }, data: [lineHandle()],
  },
  // Reads `destinationId`, `kind`, `displayName`; answers 201 for a new handle.
  registerLineHandle: {
    kind: 'json', route: 'POST /api/organizations/:accountId/line-destinations',
    call: (c) => c.registerLineHandle(A, { destinationId: `C${'1'.repeat(32)}`, kind: 'group' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/line-destinations', body: { json: { destinationId: `C${'1'.repeat(32)}`, kind: 'group' } } },
    status: 201, data: lineHandle({ kind: 'group', source: 'manual' }),
  },
  removeLineHandle: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/line-destinations/:lineDestinationId', call: (c) => c.removeLineHandle(A, 'handle-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/line-destinations/handle-1' }, data: { id: 'handle-1', removed: true },
  },
  // Reads `csv`.
  contactImportPreview: {
    kind: 'json', route: 'POST /api/organizations/:accountId/members/import/preview', call: (c) => c.contactImportPreview(A, '名前,メール\n山田 太郎,taro@example.com\n'),
    sends: { method: 'POST', path: '/api/organizations/org-1/members/import/preview', body: { json: { csv: '名前,メール\n山田 太郎,taro@example.com\n' } } },
    data: preview,
  },
  // Reads `csv`; answers 201.
  importContacts: {
    kind: 'json', route: 'POST /api/organizations/:accountId/members/import', call: (c) => c.importContacts(A, '名前\n山田 太郎\n'),
    sends: { method: 'POST', path: '/api/organizations/org-1/members/import', body: { json: { csv: '名前\n山田 太郎\n' } } },
    status: 201, data: { ...preview, imported: 1 },
  },
  contactExportUrl: {
    kind: 'url', route: 'GET /api/organizations/:accountId/members/export', call: (c) => c.contactExportUrl(A),
    url: '/api/organizations/org-1/members/export',
  },
  channelTestTargets: {
    kind: 'json', route: 'GET /api/organizations/:accountId/channel-tests/targets', call: (c) => c.channelTestTargets(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/channel-tests/targets' }, data: [target],
  },
  // Reads `contactId`, `channel`, `texts`.
  sendChannelTest: {
    kind: 'json', route: 'POST /api/organizations/:accountId/channel-tests',
    call: (c) => c.sendChannelTest(A, { contactId: 'contact-1', channel: 'line', texts: ['一通目', '二通目'] }),
    sends: { method: 'POST', path: '/api/organizations/org-1/channel-tests', body: { json: { contactId: 'contact-1', channel: 'line', texts: ['一通目', '二通目'] } } },
    data: channelDelivery,
  },
  contactLists: {
    kind: 'json', route: 'GET /api/organizations/:accountId/contact-lists', call: (c) => c.contactLists(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/contact-lists' }, data: [contactList()],
  },
  // Reads `name`, `contactIds`, and `description`, which the GUI never sends, so it is saved as ''.
  saveContactList: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/contact-lists/:listId',
    call: (c) => c.saveContactList(A, 'list-1', { name: '定例連絡', contactIds: ['contact-1', 'contact-2'] }),
    sends: { method: 'PUT', path: '/api/organizations/org-1/contact-lists/list-1', body: { json: { name: '定例連絡', contactIds: ['contact-1', 'contact-2'] } } },
    data: { id: 'list-1' },
  },

  mcpServers: {
    kind: 'json', route: 'GET /api/organizations/:accountId/mcp-servers', call: (c) => c.mcpServers(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/mcp-servers' }, data: [server],
  },
  // Reads `name`, `url`, `token`, and `revision` (left out: null).
  saveMcpServer: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/mcp-servers/:serverId',
    call: (c) => c.saveMcpServer(A, 'server-1', { name: 'line', url: 'https://mcp.example/line', token: null }),
    sends: { method: 'PUT', path: '/api/organizations/org-1/mcp-servers/server-1', body: { json: { name: 'line', url: 'https://mcp.example/line', token: null } } },
    data: { id: 'server-1' },
  },
  removeMcpServer: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/mcp-servers/:serverId', call: (c) => c.removeMcpServer(A, 'server-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/mcp-servers/server-1' }, data: { id: 'server-1' },
  },
  // Without `tool` the route lists the server's tools.
  authorizeMcpServer: {
    kind: 'json', route: 'POST /api/organizations/:accountId/mcp-servers/:serverId/authorize', call: (c) => c.authorizeMcpServer(A, 'server/1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/mcp-servers/server%2F1/authorize' },
    data: { authorizationUrl: 'https://auth.example.com/authorize?state=3' },
  },
  listMcpServerTools: {
    kind: 'json', route: 'POST /api/organizations/:accountId/mcp-servers/:serverId/tests', call: (c) => c.listMcpServerTools(A, 'server-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/mcp-servers/server-1/tests', body: { json: {} } },
    data: { server: 'line', tools: [serverTool] },
  },
  // With `tool` it calls it with `arguments`, an object.
  callMcpServerTool: {
    kind: 'json', route: 'POST /api/organizations/:accountId/mcp-servers/:serverId/tests',
    call: (c) => c.callMcpServerTool(A, 'server-1', { tool: 'push', arguments: { to: 'Uabc1', text: 'テスト' } }),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/mcp-servers/server-1/tests',
      body: { json: { tool: 'push', arguments: { to: 'Uabc1', text: 'テスト' } } },
    },
    data: { server: 'line', tool: 'push', isError: false, text: 'sent' },
  },
  // A multipart form (`{ body: 'file' }`, read by `sentMessage`), answered as Server-Sent Events.
  transcripts: {
    kind: 'json', route: 'GET /api/organizations/:accountId/transcripts', call: (c) => c.transcripts(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/transcripts' }, data: { transcripts: [transcriptSummary], transcription: true, minutes: true },
  },
  transcript: {
    kind: 'json', route: 'GET /api/organizations/:accountId/transcripts/:transcriptId', call: (c) => c.transcript(A, 'transcript/1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/transcripts/transcript%2F1' }, data: transcriptDetail,
  },
  // Reads the file part `recording`.
  uploadRecording: {
    kind: 'json', route: 'POST /api/organizations/:accountId/transcripts', status: 201,
    call: (c) => c.uploadRecording(A, new File(['ID3'], '総会.mp3', { type: 'audio/mpeg' })),
    sends: { method: 'POST', path: '/api/organizations/org-1/transcripts', body: { form: [['recording', { name: '総会.mp3', type: 'audio/mpeg', text: 'ID3' }]] } },
    data: transcriptSummary,
  },
  // Reads `title`.
  renameTranscript: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/transcripts/:transcriptId', call: (c) => c.renameTranscript(A, 'transcript-1', '10月の総会'),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/transcripts/transcript-1', body: { json: { title: '10月の総会' } } },
    data: { ...transcriptSummary, title: '10月の総会' },
  },
  removeTranscript: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/transcripts/:transcriptId', call: (c) => c.removeTranscript(A, 'transcript-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/transcripts/transcript-1' }, data: { id: 'transcript-1', deleted: true },
  },
  transcribeAgain: {
    kind: 'json', route: 'POST /api/organizations/:accountId/transcripts/:transcriptId/transcribe', call: (c) => c.transcribeAgain(A, 'transcript-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/transcripts/transcript-1/transcribe' }, data: { ...transcriptSummary, state: 'transcribing' },
  },
  // Reads `instructions`.
  writeMinutes: {
    kind: 'json', route: 'POST /api/organizations/:accountId/transcripts/:transcriptId/minutes', call: (c) => c.writeMinutes(A, 'transcript-1', { instructions: '箇条書きで' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/transcripts/transcript-1/minutes', body: { json: { instructions: '箇条書きで' } } },
    data: { ...transcriptDetail, minutesState: 'writing', minutesInstructions: '箇条書きで' },
  },
  recordingUrl: {
    kind: 'url', route: 'GET /api/organizations/:accountId/transcripts/:transcriptId/recording',
    call: (c) => c.recordingUrl(A, 'transcript/1'),
    url: '/api/organizations/org-1/transcripts/transcript%2F1/recording',
  },
  chatThreads: {
    kind: 'json', route: 'GET /api/organizations/:accountId/chat-threads', call: (c) => c.chatThreads(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/chat-threads' }, data: [chatThread],
  },
  // Reads nothing; answers 201.
  createChatThread: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads', call: (c) => c.createChatThread(A),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads' }, status: 201, data: chatThread,
  },
  // Reads `text`, `delivery`, `model`, and each `attachment` part.
  sendChatThreadMessage: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/messages',
    call: (c) => c.sendChatThreadMessage(A, 'thread-1', { text: 'この写真の予定を', delivery: 'queue', effort: 'max' }, [new File(['PNG'], '写真.png', { type: 'image/png' })]),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/messages',
      body: { form: [['text', 'この写真の予定を'], ['delivery', 'queue'], ['effort', 'max'], ['attachment', { name: '写真.png', type: 'image/png', text: 'PNG' }]] },
    },
    data: { threadId: 'thread-1', accepted: true },
  },
  // Reads `action`, `runId`, and `text` or `beforeRunId`.
  changeChatThreadQueue: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/queue',
    call: (c) => c.changeChatThreadQueue(A, 'thread-1', { action: 'move', runId: 'run-2', beforeRunId: null }),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/queue', body: { json: { action: 'move', runId: 'run-2', beforeRunId: null } } },
    data: { threadId: 'thread-1', accepted: true },
  },
  interruptChatThread: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/interrupt', call: (c) => c.interruptChatThread(A, 'thread-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/interrupt' }, data: { threadId: 'thread-1', accepted: false },
  },
  answerChatThreadApproval: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/approvals',
    call: (c) => c.answerChatThreadApproval(A, 'thread-1', { requestId: 'request-1', decision: 'decline', feedback: '宛先が違います' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/approvals', body: { json: { requestId: 'request-1', decision: 'decline', feedback: '宛先が違います' } } },
    data: { threadId: 'thread-1', accepted: true },
  },
  // The modes the composer offers: 自動 only where the Worker holds an OpenRouter key.
  chatThreadModes: {
    kind: 'json', route: 'GET /api/organizations/:accountId/chat-threads/:threadId/mode', call: (c) => c.chatThreadModes(A, 'thread-1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/chat-threads/thread-1/mode' }, data: { modes: ['read_only', 'ask', 'unrestricted'] },
  },
  // What the member is likely to write next, greyed in the composer until they type.
  chatThreadSuggestion: {
    kind: 'json', route: 'GET /api/organizations/:accountId/chat-threads/:threadId/suggestion', call: (c) => c.chatThreadSuggestion(A, 'thread-1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/chat-threads/thread-1/suggestion' }, data: { runId: 'run-1', text: '送って' },
  },
  setChatThreadMode: {
    kind: 'json', route: 'PUT /api/organizations/:accountId/chat-threads/:threadId/mode',
    call: (c) => c.setChatThreadMode(A, 'thread-1', { mode: 'ask' }),
    sends: { method: 'PUT', path: '/api/organizations/org-1/chat-threads/thread-1/mode', body: { json: { mode: 'ask' } } },
    data: { threadId: 'thread-1', accepted: true },
  },
  // Reads `title`; its place in the list stays.
  renameChatThread: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/chat-threads/:threadId',
    call: (c) => c.renameChatThread(A, 'thread-1', { title: '請求の確認' }),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/chat-threads/thread-1', body: { json: { title: '請求の確認' } } },
    data: { ...chatThread, title: '請求の確認' },
  },
  deleteChatThread: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/chat-threads/:threadId', call: (c) => c.deleteChatThread(A, 'thread-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/chat-threads/thread-1' }, data: { id: 'thread-1', deleted: true },
  },
  // Reads `messageId`, `text`, `model`, `effort`, each `drop`, and each `attachment`.
  rewindChatThread: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/rewind',
    call: (c) => c.rewindChatThread(A, 'thread-1', { messageId: 'run-1:user', text: '直した', model: 'model-b', drop: ['photo-1', 'photo-2'] }, [new File(['PNG'], '写真.png', { type: 'image/png' })]),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/rewind',
      body: { form: [['messageId', 'run-1:user'], ['text', '直した'], ['model', 'model-b'], ['drop', 'photo-1'], ['drop', 'photo-2'], ['attachment', { name: '写真.png', type: 'image/png', text: 'PNG' }]] },
    },
    data: { threadId: 'thread-1', accepted: true },
  },
  // Reads `runId`; answers 201 with the new conversation.
  forkChatThread: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/fork', call: (c) => c.forkChatThread(A, 'thread-1', 'run-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/fork', body: { json: { runId: 'run-1' } } },
    status: 201, data: { ...chatThread, id: 'thread-2', title: '請求の確認（続き）' },
  },
  chatCapabilities: {
    kind: 'json', route: 'GET /api/organizations/:accountId/chat-capabilities', call: (c) => c.chatCapabilities(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/chat-capabilities' }, data: { models: ['model-a', 'model-b'], efforts: { 'model-a': { levels: ['low', 'high'], default: null } }, drivePicker: true },
  },
  // Null where Google Picker is not configured.
  chatDrivePicker: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-drive-picker', call: (c) => c.chatDrivePicker(A),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-drive-picker' }, data: { apiKey: 'key', appId: '1234567890', accessToken: 'token' },
  },
  // Reads `folderId`; without one, the file goes into AI に聞く.
  saveChatFileToDrive: {
    kind: 'json', route: 'POST /api/organizations/:accountId/chat-threads/:threadId/files/:fileId/drive',
    call: (c) => c.saveChatFileToDrive(A, 'thread-1', 'file-1', { folderId: 'folder-chosen-1' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/chat-threads/thread-1/files/file-1/drive', body: { json: { folderId: 'folder-chosen-1' } } },
    data: { fileId: 'drive-1', url: 'https://drive.google.com/file/d/drive-1' },
  },
  // The file itself, named as Drive hands it over.
  chatDriveFile: {
    kind: 'raw', route: 'GET /api/organizations/:accountId/chat-drive-files/:fileId',
    call: (c) => c.chatDriveFile(A, 'drive-file-1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/chat-drive-files/drive-file-1' },
    reply: () => new Response('%PDF-1.4', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('議事録.pdf')}` } }),
    run: async (c) => {
      const file = await c.chatDriveFile(A, 'drive-file-1');
      expect([file.name, file.type, await file.text()]).toEqual(['議事録.pdf', 'application/pdf', '%PDF-1.4']);
    },
  },
  // A WebSocket on the page's own origin, after the sequence the screen applied last.
  chatThreadStreamUrl: {
    kind: 'url', route: 'GET /api/organizations/:accountId/chat-threads/:threadId/stream',
    call: (c) => c.chatThreadStreamUrl(A, 'thread/1', 12, 'https://gui.test/chat/thread'),
    url: 'wss://gui.test/api/organizations/org-1/chat-threads/thread%2F1/stream?afterSequence=12',
  },
  chatThreadFileUrl: {
    kind: 'url', route: 'GET /api/organizations/:accountId/chat-threads/:threadId/files/:fileId',
    call: (c) => c.chatThreadFileUrl(A, 'thread-1', 'file/1'),
    url: '/api/organizations/org-1/chat-threads/thread-1/files/file%2F1',
  },
  // The VAPID public key, or null where the Worker holds none and push is unavailable.
  pushSettings: {
    kind: 'json', route: 'GET /api/organizations/:accountId/push', call: (c) => c.pushSettings(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/push' }, data: { publicKey: 'BKey' },
  },
  savePushDevice: {
    kind: 'json', route: 'POST /api/organizations/:accountId/push/devices',
    call: (c) => c.savePushDevice(A, { endpoint: 'https://push.example.net/1', keys: { p256dh: 'BKey', auth: 'secret' }, label: 'iPhone の Safari' }),
    sends: { method: 'POST', path: '/api/organizations/org-1/push/devices', body: { json: { endpoint: 'https://push.example.net/1', keys: { p256dh: 'BKey', auth: 'secret' }, label: 'iPhone の Safari' } } },
    data: { subscribed: true },
  },
  // Reads `endpoint`: only the member's own browser stops being notified.
  removePushDevice: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/push/devices', call: (c) => c.removePushDevice(A, 'https://push.example.net/1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/push/devices', body: { json: { endpoint: 'https://push.example.net/1' } } },
    data: { subscribed: false },
  },
  accessTokens: {
    kind: 'json', route: 'GET /api/organizations/:accountId/access-tokens', call: (c) => c.accessTokens(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/access-tokens' }, data: [accessToken],
  },
  // Reads `name`, `contactListId`, `tools`, `suppressionWindow`.
  issueAccessToken: {
    kind: 'json', route: 'POST /api/organizations/:accountId/access-tokens',
    call: (c) => c.issueAccessToken(A, { name: 'Agent', tools: ['send_message'] }),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/access-tokens',
      body: { json: { name: 'Agent', tools: ['send_message'] } },
    },
    data: issuedToken,
  },
  revokeAccessToken: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/access-tokens/:tokenId', call: (c) => c.revokeAccessToken(A, 'token-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/access-tokens/token-1' }, data: { id: 'token-1' },
  },
  operatorTokens: {
    kind: 'json', route: 'GET /api/organizations/:accountId/operator-tokens', call: (c) => c.operatorTokens(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/operator-tokens' }, data: [operatorToken],
  },
  mcpEndpoint: {
    kind: 'json', route: 'GET /api/organizations/:accountId/mcp-endpoint', call: (c) => c.mcpEndpoint(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/mcp-endpoint' }, data: { url: 'https://orangeagent.example/api/public/organizations/org-1/mcp' },
  },
  issueLoginCode: {
    kind: 'json', route: 'POST /api/organizations/:accountId/login-codes', call: (c) => c.issueLoginCode(A),
    sends: { method: 'POST', path: '/api/organizations/org-1/login-codes' }, data: loginCode,
  },
  revokeOperatorToken: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/operator-tokens/:tokenId', call: (c) => c.revokeOperatorToken(A, 'operator-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/operator-tokens/operator-1' }, data: { id: 'operator-1' },
  },
  automations: {
    kind: 'json', route: 'GET /api/organizations/:accountId/automations', call: (c) => c.automations(A),
    sends: { method: 'GET', path: '/api/organizations/org-1/automations' }, data: [automation()],
  },
  automation: {
    kind: 'json', route: 'GET /api/organizations/:accountId/automations/:automationId', call: (c) => c.automation(A, 'automation/1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/automations/automation%2F1' }, data: automation(),
  },
  // Reads every AutomationSettings field; answers 201.
  createAutomation: {
    kind: 'json', route: 'POST /api/organizations/:accountId/automations',
    call: (c) => c.createAutomation(A, {
      name: '朝の確認', enabled: false, schedule: 'daily 09:00', executionMode: 'unattended', skillIds: ['prompt-1'], tools: ['query_contacts'],
      suppressionWindow: 'day', model: null,
    }),
    sends: {
      method: 'POST', path: '/api/organizations/org-1/automations',
      body: { json: {
        name: '朝の確認', enabled: false, schedule: 'daily 09:00', executionMode: 'unattended', skillIds: ['prompt-1'], tools: ['query_contacts'],
        suppressionWindow: 'day', model: null,
      } },
    },
    status: 201, data: automation({ enabled: false }),
  },
  // Reads any AutomationSettings field given.
  updateAutomation: {
    kind: 'json', route: 'PATCH /api/organizations/:accountId/automations/:automationId',
    call: (c) => c.updateAutomation(A, 'automation/1', { enabled: true, model: 'claude-haiku' }),
    sends: { method: 'PATCH', path: '/api/organizations/org-1/automations/automation%2F1', body: { json: { enabled: true, model: 'claude-haiku' } } },
    data: automation({ model: 'claude-haiku' }),
  },
  removeAutomation: {
    kind: 'json', route: 'DELETE /api/organizations/:accountId/automations/:automationId', call: (c) => c.removeAutomation(A, 'automation-1'),
    sends: { method: 'DELETE', path: '/api/organizations/org-1/automations/automation-1' }, data: { id: 'automation-1', deleted: true },
  },
  tryAutomation: {
    kind: 'json', route: 'POST /api/organizations/:accountId/automations/:automationId/trial', call: (c) => c.tryAutomation(A, 'automation-1'),
    sends: { method: 'POST', path: '/api/organizations/org-1/automations/automation-1/trial' },
    data: {
      automation: { id: 'automation-1', revision: 1 }, model: 'claude-sonnet', output: '1件作ります。', toolCalls: 2, tokens: 300,
      planned: [{ tool: 'tasks.create', arguments: { title: '参加費', due: null } }], error: null,
    },
  },
  // Reads `automationId` from the query.
  runs: {
    kind: 'json', route: 'GET /api/organizations/:accountId/runs', call: (c) => c.runs(A, 'automation/1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/runs', query: { automationId: 'automation/1' } }, data: [run()],
  },
  // Reads `decision`, 'approve' or 'reject'.
  decideRun: {
    kind: 'json', route: 'POST /api/organizations/:accountId/runs/:runId/decision', call: (c) => c.decideRun(A, 'run-1', 'reject'),
    sends: { method: 'POST', path: '/api/organizations/org-1/runs/run-1/decision', body: { json: { decision: 'reject' } } },
    data: run({ status: 'rejected' }),
  },
  runTranscript: {
    kind: 'json', route: 'GET /api/organizations/:accountId/runs/:runId/transcript', call: (c) => c.runTranscript(A, 'run-1'),
    sends: { method: 'GET', path: '/api/organizations/org-1/runs/run-1/transcript' }, data: transcript(),
  },
};

const names = Object.keys(table) as Method[];
const rows = names.map((name) => [name, table[name]] as const);
const requestRows = rows.flatMap(([name, row]) => row.kind === 'url' ? [] : [[name, row] as const]);

/** One request as fetch received it. */
interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: BodyInit | null | undefined;
}

const recordFetch = (reply: () => Response | Promise<Response>): Recorded[] => {
  const recorded: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    recorded.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
      body: init?.body,
    });
    return reply();
  }));
  return recorded;
};

const replyOf = (row: JsonRow<Method> | RawRow<Method>): (() => Response) =>
  row.kind === 'raw' ? row.reply : () => new Response(JSON.stringify({ data: row.data }), { status: row.status ?? 200 });

const sentFile = async (file: Blob, name?: string): Promise<SentFile> =>
  ({ ...(name === undefined ? {} : { name }), type: file.type, text: await file.text() });

/** A body as the Worker receives it; a file sent as the whole body has the type its Content-Type header names. */
const sentBody = async (body: BodyInit | null | undefined, headers = new Headers()): Promise<SentBody | undefined> => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return { json: JSON.parse(body) as unknown };
  if (body instanceof FormData) {
    const entries: Array<[string, string | SentFile]> = [];
    for (const [name, value] of body.entries()) entries.push([name, typeof value === 'string' ? value : await sentFile(value, value.name)]);
    return { form: entries };
  }
  if (body instanceof Blob) return { file: { type: headers.get('content-type') ?? '', text: await body.text() } };
  throw new Error(`Unexpected request body ${String(body)}`);
};

let declared: string[] | undefined;

/** Each route a Worker module declares, as `VERB /path` under the prefix apps/worker/src/app.ts mounts it at. */
const workerRoutes = (): string[] => {
  if (declared) return declared;
  const source = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../worker/src/${relative}`, import.meta.url)), 'utf8');
  const mounts = [...source('app.ts').matchAll(/app\.route\('([^']*)',\s*(\w+)/gu)].map(([, prefix = '', name = '']) => ({ prefix, name }));
  expect(mounts.length).toBeGreaterThan(20);
  expect(new Set(mounts.map(({ prefix }) => prefix))).toEqual(new Set(['/api', '/']));
  const atRoot = new Set(mounts.filter(({ prefix }) => prefix === '/').map(({ name }) => name));
  const directory = fileURLToPath(new URL('../../worker/src/routes/', import.meta.url));
  declared = readdirSync(directory)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => [...source(`routes/${file}`).matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*'(\/[^']*)'/gu)])
    .map(([, name = '', verb = '', path = '']) => `${verb.toUpperCase()} ${atRoot.has(name) ? '' : '/api'}${path}`);
  return declared;
};

/** Whether a request's method and path are what a Hono route `VERB /a/:param/b` matches. */
const matches = (route: string, method: string, path: string): boolean => {
  const [verb = '', pattern = ''] = route.split(' ');
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/:[A-Za-z]+/gu, '[^/]+');
  return verb === method && new RegExp(`^${expression}$`, 'u').test(path);
};

const refusal = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the client table', () => {
  it('has one row for every method the client exports, and the module exports nothing else', () => {
    expect(new Set(names)).toEqual(new Set(Object.keys(api)));
    expect(Object.keys(client).sort()).toEqual(['ApiError', 'api']);
  });

  it('names, for every row, a route the Worker declares', () => {
    const declared = new Set(workerRoutes());
    const missing = rows.filter(([, row]) => !declared.has(row.route)).map(([name, row]) => `${name}: ${row.route}`);
    expect(missing).toEqual([]);
  });
});

describe('every client method', () => {
  it.each(requestRows)('%s sends what its Worker route reads', async (name, row) => {
    const recorded = recordFetch(replyOf(row));

    if (row.kind === 'raw') await row.run(api);
    else expect(await row.call(api)).toEqual(row.data);

    expect(recorded).toHaveLength(1);
    const [sent] = recorded;
    if (!sent) throw new Error(`${name} sent nothing`);
    const url = new URL(sent.url, 'https://gui.test');
    // The GUI reaches the Worker on its own origin, so the session cookie goes with every request.
    expect(sent.url.startsWith('/')).toBe(true);
    expect(sent.credentials).toBe('include');
    expect(sent.method).toBe(row.sends.method);
    expect(url.pathname).toBe(row.sends.path);
    expect(Object.fromEntries(url.searchParams)).toEqual(row.sends.query ?? {});
    if (!row.sends.query) expect(url.search).toBe('');
    // The request reaches the route the row names, and no other route of the Worker's could take it.
    expect(workerRoutes().filter((route) => matches(route, sent.method, url.pathname))).toEqual([row.route]);

    expect(await sentBody(sent.body, sent.headers)).toStrictEqual(row.sends.body);
    if (row.sends.body && 'json' in row.sends.body) expect(sent.headers.get('content-type')).toBe('application/json');
    // The browser writes a multipart form's boundary itself, so the client must not name the type.
    if (row.sends.body && 'form' in row.sends.body) expect(sent.headers.get('content-type')).toBeNull();
    for (const [header, value] of Object.entries(row.sends.headers ?? {})) expect(sent.headers.get(header)).toBe(value);
  });

  it.each(rows.flatMap(([name, row]) => row.kind === 'url' ? [[name, row] as const] : []))('%s builds the address its Worker route serves', (_name, row) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const url = row.call(api);

    expect(url).toBe(row.url);
    const parsed = new URL(url, 'https://gui.test');
    expect(workerRoutes().filter((route) => matches(route, 'GET', parsed.pathname))).toEqual([row.route]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(requestRows)('%s rejects with the Worker\'s refusal as the message a screen shows', async (_name, row) => {
    recordFetch(() => refusal(403, 'no_access', 'このアカウントへのアクセス権がありません。'));

    const failure = await (async (): Promise<unknown> => row.call(api))().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ name: 'ApiError', status: 403, code: 'no_access', message: 'このアカウントへのアクセス権がありません。' });
  });

  it.each(requestRows)('%s rejects when the network fails', async (_name, row) => {
    const offline = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(offline));

    await expect((async (): Promise<unknown> => row.call(api))()).rejects.toBe(offline);
  });
});

describe('a refusal', () => {
  it('keeps the status a screen tells a missing record by', async () => {
    recordFetch(() => refusal(404, 'not_found', 'Scheduled Event was not found.'));

    const failure = await api.event(A, 'event-1').catch((error: unknown) => error);

    // screens/event.tsx turns a 404 into its not-found page.
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, code: 'not_found', message: 'Scheduled Event was not found.' });
  });

  it('says the service could not be reached when the refusal has no body', async () => {
    recordFetch(() => new Response(null, { status: 502 }));

    await expect(api.bootstrap()).rejects.toMatchObject({
      name: 'ApiError', status: 502, message: 'サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。',
    });
  });

  it('explains that the URL may be stale when the answer is an HTML page', async () => {
    recordFetch(() => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }));

    await expect(api.bootstrap()).rejects.toThrow('サービスから正しい応答を受け取れませんでした。URLを確認して画面を再読み込みしてください。');
  });

  it('says nothing was answered when a success has no body', async () => {
    recordFetch(() => new Response(null, { status: 200 }));

    await expect(api.dashboard(A)).rejects.toThrow('サービスから応答がありませんでした。画面を再読み込みしてください。');
  });

  it('keeps the schema diagnostics the Worker answers when a database is not ready', async () => {
    recordFetch(() => new Response(JSON.stringify({
      error: {
        code: 'schema_not_ready',
        message: 'organization database schema is not ready.',
        category: 'database_ahead',
        databaseKind: 'organization',
        databaseId: 'database-1',
        bindingName: 'ORG_ORGANIZATION1',
        currentMigration: '9999_future.sql',
        expectedMigration: '0017_member_portal.sql',
        requestId: 'request-1',
      },
    }), { status: 503 }));

    const failure = await api.bootstrap().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 503,
      code: 'schema_not_ready',
      category: 'database_ahead',
      databaseKind: 'organization',
      databaseId: 'database-1',
      bindingName: 'ORG_ORGANIZATION1',
      currentMigration: '9999_future.sql',
      expectedMigration: '0017_member_portal.sql',
      requestId: 'request-1',
      message: 'データベースのマイグレーション状態が不正です（organization: 現在 9999_future.sql / 期待 0017_member_portal.sql、request ID: request-1）。',
    });
  });
});

describe('bootstrap', () => {
  it('shares concurrent requests so one navigation does not fetch the same state twice', async () => {
    let resolveResponse: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const first = api.bootstrap();
    const second = api.bootstrap();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({ data: { kind: 'signed_out' } }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ kind: 'signed_out' }, { kind: 'signed_out' }]);
  });

  it('asks again once a failed request has settled', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: ready }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.bootstrap()).rejects.toThrow('Failed to fetch');
    await expect(api.bootstrap()).resolves.toEqual(ready);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('optional arguments', () => {
  it.each<[string, (c: Api) => Promise<unknown>, Sent]>([
    ['beginGoogleLogin without a page to return to', (c) => c.beginGoogleLogin(), { method: 'POST', path: '/api/entry/google', body: { json: {} } }],
    ['logout of every person', (c) => c.logout({ everyone: true }), { method: 'POST', path: '/api/auth/logout', body: { json: { everyone: true } } }],
    ['logout of the current person', (c) => c.logout(), { method: 'POST', path: '/api/auth/logout', body: { json: {} } }],
    ['upcoming events', (c) => c.events(A), { method: 'GET', path: '/api/organizations/org-1/events' }],
    ['every run', (c) => c.runs(A), { method: 'GET', path: '/api/organizations/org-1/runs' }],
    ['a preset without a conflict policy', (c) => c.applyPreset(A, 'preset-1'), { method: 'POST', path: '/api/organizations/org-1/presets/preset-1/apply', body: { json: {} } }],
  ])('%s', async (_name, call, expected) => {
    const recorded = recordFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await call(api);

    const [sent] = recorded;
    if (!sent) throw new Error('nothing was sent');
    const url = new URL(sent.url, 'https://gui.test');
    expect(sent.method).toBe(expected.method);
    expect(url.pathname).toBe(expected.path);
    expect(Object.fromEntries(url.searchParams)).toEqual(expected.query ?? {});
    expect(await sentBody(sent.body)).toStrictEqual(expected.body);
  });

  it('sends a Skill file of a named type under that type', async () => {
    const recorded = recordFetch(() => new Response(JSON.stringify({ data: skill() }), { status: 200 }));

    await api.writeSkillFile(A, 'skill-1', 'data.csv', new Blob(['a,b'], { type: 'text/csv' }));

    expect(recorded[0]?.headers.get('content-type')).toBe('text/csv');
  });
});

describe('the provisioning screen', () => {
  it('names the concrete provisioning phase shown after a failure', () => {
    expect(setupPhaseLabel('storing_credentials')).toBe('Google との接続を保存しています');
  });
});
