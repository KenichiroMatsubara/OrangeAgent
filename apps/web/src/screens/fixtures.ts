import type { AppState, Automation, AutomationException, AutomationStatus, Connections, Contact, ContactList, Dashboard, DeliveryRecord, EventDetail, EventOverview, LineHandleRecord, Run, RunTranscript, Skill, TranscriptDetail } from '@mail/domain';

/** The one Account every screen test signs into. */
export const ACCOUNT_ID = 'org-1';

export const ready: AppState = {
  kind: 'ready',
  identity: { email: 'owner@example.com', displayName: 'Owner' },
  people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: ACCOUNT_ID, name: 'Example', status: 'active' } }],
  account: { accountId: ACCOUNT_ID, name: 'Example', status: 'active' },
};

export const automationStatus = (overrides: Partial<AutomationStatus> = {}): AutomationStatus => ({
  email: 'inbox@example.com',
  displayName: 'Inbox',
  status: 'active',
  lastError: null,
  failingSince: null,
  draftsGranted: true,
  driveGranted: true,
  meetGranted: true,
  tasksGranted: true,
  ...overrides,
});

export const connections = (overrides: Partial<Connections> = {}): Connections => ({
  accountId: ACCOUNT_ID,
  accountName: 'Example',
  line: { channelAccessTokenConfigured: true, channelSecretConfigured: true, webhookUrl: 'https://flarechat.example/api/line/webhook' },
  ai: { apiKeyConfigured: true, model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'], provider: 'openai' },
  transcription: { apiKeyConfigured: false, model: '' },
  microsoft: { configured: true, connected: false, email: null },
  ...overrides,
});

export const skill = (overrides: Partial<Skill> = {}): Skill => ({
  id: 'prompt-1',
  accountId: ACCOUNT_ID,
  name: 'morning-check',
  description: 'When the morning list is written.',
  files: [{ path: 'SKILL.md', size: 80, mediaType: 'text/markdown' }],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
  // The title a person reads; a test that names a Skill only by its name reads it by that name.
  title: overrides.title ?? overrides.name ?? 'Morning check',
});

export const contact = (overrides: Partial<Contact> = {}): Contact => ({
  id: 'contact-1',
  accountId: ACCOUNT_ID,
  name: '山田 太郎',
  email: 'taro@example.com',
  state: 'active',
  description: '会計',
  tags: ['2026'],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  lineDestinations: [],
  ...overrides,
});

export const lineHandle = (overrides: Partial<LineHandleRecord> = {}): LineHandleRecord => ({
  id: 'handle-1',
  destinationId: 'Uabc1',
  displayName: '花子',
  kind: 'user',
  status: 'discovered',
  source: 'webhook',
  discoveredAt: '2026-08-01T00:00:00.000Z',
  contactId: null,
  ...overrides,
});

export const contactList = (overrides: Partial<ContactList> = {}): ContactList => ({
  id: 'list-1',
  name: '定例連絡',
  description: '',
  contactIds: ['contact-1'],
  ...overrides,
});

export const run = (overrides: Partial<Run> = {}): Run => ({
  id: 'run-1',
  trigger: 'schedule',
  automation: { id: 'automation-1', name: '毎朝のメール処理', revision: 2 },
  sourceMessage: null,
  executionMode: 'approval',
  status: 'pending_approval',
  startedAt: '2026-08-18T09:00:00.000Z',
  finishedAt: null,
  expiresAt: '2026-08-25T09:00:00.000Z',
  model: 'gpt-4.1-mini',
  toolCalls: 3,
  tokens: 900,
  output: '予定を1件作る計画です。',
  error: null,
  transcript: true,
  writes: [],
  ...overrides,
});

export const delivery = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: 'delivery-1',
  eventId: null,
  sourceMessageId: 'message-1',
  channel: 'line',
  destination: 'Uabc1',
  outcome: 'succeeded',
  externalId: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

export const exception = (overrides: Partial<AutomationException> = {}): AutomationException => ({
  id: 'exception-1',
  sourceMessageId: 'message-1',
  code: 'ai_connection_missing',
  message: 'No AI Connection is configured.',
  state: 'open',
  createdAt: '2026-08-18T09:00:00.000Z',
  resolvedAt: null,
  ...overrides,
});

/** An Automation, every morning at 09:00. */
export const automation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'automation-1',
  name: '朝の確認',
  enabled: true,
  schedule: 'daily 09:00',
  executionMode: 'unattended',
  skillIds: ['prompt-1'],
  tools: ['query_contacts'],
  suppressionWindow: 'day',
  model: null,
  revision: 1,
  nextRunAt: '2026-09-03T00:00:00.000Z',
  lastRun: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

export const transcript = (overrides: Partial<RunTranscript> = {}): RunTranscript => ({
  runId: 'run-1',
  source: null,
  request: 'Run now. This Automation has not run before.',
  messages: [],
  finalOutput: '予定を1件作成しました。',
  error: null,
  ...overrides,
});

export const dashboard = (overrides: Partial<Dashboard> = {}): Dashboard => ({
  automations: [{
    id: 'automation-1', name: '毎朝のメール処理', enabled: true, schedule: 'daily 05:00', nextRunAt: '2026-08-01T20:00:00.000Z',
    lastRun: { id: 'run-1', startedAt: '2026-07-31T20:00:00.000Z', status: 'completed', error: null },
  }],
  attention: [],
  upcomingEvents: [],
  ...overrides,
});

export const eventOverview = (overrides: Partial<EventOverview> = {}): EventOverview => ({
  id: 'event-1',
  title: '秋季総会',
  startsAt: '2026-08-20T01:00:00.000Z',
  endsAt: '2026-08-20T03:00:00.000Z',
  location: '市民会館',
  status: 'scheduled',
  responseDeadline: '2026-08-15',
  attending: 12,
  notAttending: 3,
  unanswered: 5,
  guestsAttending: 3,
  sourceSubject: '総会のご案内',
  ...overrides,
});

export const eventDetail = (overrides: Partial<EventDetail> = {}): EventDetail => ({
  ...eventOverview(),
  description: '',
  registrations: [
    { contactId: 'contact-1', name: '山田 太郎', status: 'attending', comment: '', updatedAt: '2026-07-30T00:00:00.000Z' },
    { contactId: 'contact-2', name: '佐藤 花子', status: 'unanswered', comment: '', updatedAt: '2026-07-25T00:00:00.000Z' },
  ],
  guests: [{ name: '中村 誠', affiliation: '東町内会', attending: true }],
  source: { subject: '総会のご案内', sender: 'info@higashi.example.jp', receivedAt: '2026-07-20T00:00:00.000Z' },
  ...overrides,
});

/** One recording on 文字起こし, transcribed, with two speakers and no minutes yet. */
export const recording = (overrides: Partial<TranscriptDetail> = {}): TranscriptDetail => ({
  id: 'transcript-1',
  title: '10月の役員会.m4a',
  filename: '10月の役員会.m4a',
  mediaType: 'audio/mp4',
  size: 18_400_000,
  state: 'completed',
  error: null,
  durationSeconds: 2_745,
  model: 'microsoft/mai-transcribe-2',
  speakers: 3,
  minutesState: null,
  createdBy: '山田 太郎',
  createdAt: '2026-10-11T10:05:00.000Z',
  updatedAt: '2026-10-11T10:07:00.000Z',
  lines: [
    { at: 2.4, speaker: '話者1', text: 'それでは10月の役員会を始めます。今日の議題は秋祭りの準備と、会費の集め方の二つです。' },
    { at: 14.8, speaker: '話者2', text: '秋祭りのテントは、去年と同じく公民館から6張り借りられることになりました。' },
    { at: 31.2, speaker: '話者3', text: '設営の人手が足りないので、各班から2人ずつ出してもらえると助かります。' },
    { at: 45.0, speaker: '話者1', text: 'では各班2人ずつでお願いします。班長さんから名前を今月20日までにもらいましょう。' },
    { at: 62.7, speaker: '話者2', text: '会費は、来年度から口座振替にできないか銀行に聞いてみます。' },
  ],
  minutes: null,
  minutesError: null,
  minutesModel: null,
  minutesInstructions: '',
  ...overrides,
});
