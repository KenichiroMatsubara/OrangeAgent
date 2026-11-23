import type {
  BrowserLogin,
  BrowserSettings,
  BrowserSignIn,
  MinutesInput,
  TranscriptDetail,
  TranscriptList,
  TranscriptSummary,
  AccessToken,
  AuthorizationDecision,
  AuthorizationPreview,
  AccessTokenInput,
  ApiErrorDetails,
  ApiFailure,
  ApiResult,
  AppState,
  AttendanceStatus,
  Automation,
  AutomationException,
  AutomationInput,
  AutomationUpdate,
  AutomationStatus,
  AutomationTrial,
  AutomationWarning,
  ChannelTestDelivery,
  ChannelTestTarget,
  ChatCapabilities,
  ChatDrivePicker,
  ChatDriveSave,
  ChatDriveSaved,
  ChatThread,
  ChatThreadApproval,
  ChatThreadDeleted,
  ChatThreadDispatch,
  ChatThreadRename,
  ChatThreadRewind,
  ChatThreadMessage,
  ChatThreadMode,
  ChatThreadModes,
  ChatThreadSuggestion,
  ChatThreadQueue,
  Connections,
  Contact,
  ContactImportPreview,
  ContactImportResult,
  ContactInput,
  ContactList,
  ContactListInput,
  ContactPage,
  ContactUpdate,
  Dashboard,
  DeliveryRecord,
  DriveFolders,
  EventDetail,
  EventOverview,
  GuestRegistrationRoster,
  IssuedAccessToken,
  IssuedLoginCode,
  LineHandle,
  LineHandleInput,
  LineHandleRecord,
  McpServer,
  McpServerInput,
  McpServerTool,
  McpServerToolResult,
  McpEndpoint,
  OperatorToken,
  PushDevice,
  PushDeviceState,
  PushSettings,
  Preset,
  PresetApplication,
  Memory,
  MemoryDetail,
  MemoryList,
  MemorySearch,
  Skill,
  SkillFileMove,
  Run,
  RunTranscript,
  StuckJob,
} from '@mail/domain';
import { CHAT_THREAD_FORM, type AiProvider } from '@mail/domain';
import { browserZone } from './time';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly category: string | undefined;
  readonly databaseKind: 'control' | 'organization' | undefined;
  readonly databaseId: string | null | undefined;
  readonly bindingName: string | undefined;
  readonly currentMigration: string | undefined;
  readonly expectedMigration: string | undefined;
  readonly requestId: string | undefined;

  constructor(error: ApiErrorDetails, status: number) {
    const message = error.code === 'schema_not_ready'
      ? `データベースのマイグレーション状態が不正です（${error.databaseKind ?? 'unknown'}: 現在 ${error.currentMigration ?? '不明'} / 期待 ${error.expectedMigration ?? '不明'}、request ID: ${error.requestId ?? '不明'}）。`
      : error.message ?? 'サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。';
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.category = error.category;
    this.databaseKind = error.databaseKind;
    this.databaseId = error.databaseId;
    this.bindingName = error.bindingName;
    this.currentMigration = error.currentMigration;
    this.expectedMigration = error.expectedMigration;
    this.requestId = error.requestId;
  }
}

const responseBody = async <T>(response: Response): Promise<(ApiResult<T> & ApiFailure) | null> => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as ApiResult<T> & ApiFailure; }
  catch { throw new Error('サービスから正しい応答を受け取れませんでした。URLを確認して画面を再読み込みしてください。'); }
};

/** The one seam every request passes through: cookies, JSON, and the Worker's failure shape. */
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await responseBody<T>(response);
  if (!response.ok) throw new ApiError(body?.error ?? {}, response.status);
  if (!body) throw new Error('サービスから応答がありませんでした。画面を再読み込みしてください。');
  return body.data;
};

/** Posts a form, such as one carrying a file; the browser writes the form's boundary itself. */
const postForm = async <T>(path: string, body: FormData): Promise<T> => {
  const response = await fetch(path, { method: 'POST', credentials: 'include', body });
  const parsed = await responseBody<T>(response);
  if (!response.ok) throw new ApiError(parsed?.error ?? {}, response.status);
  if (!parsed) throw new Error('サービスから応答がありませんでした。画面を再読み込みしてください。');
  return parsed.data;
};

/** A recording as the transcripts route takes it: one file part. */
const recordingForm = (file: File): FormData => {
  const form = new FormData();
  form.set('recording', file);
  return form;
};

/** A message as Operator Chat's route takes it, each file a part sent as its bytes. */
const threadMessageForm = (input: ChatThreadMessage, files: readonly File[]): FormData => {
  const form = new FormData();
  form.set(CHAT_THREAD_FORM.text, input.text);
  if (input.delivery) form.set(CHAT_THREAD_FORM.delivery, input.delivery);
  if (input.model) form.set(CHAT_THREAD_FORM.model, input.model);
  if (input.effort) form.set(CHAT_THREAD_FORM.effort, input.effort);
  for (const file of files) form.append(CHAT_THREAD_FORM.attachment, file);
  return form;
};

/** A message rewritten in place of an earlier one, as Operator Chat's route takes it: the files it leaves out named, each file added a part sent as its bytes. */
const threadRewindForm = (input: ChatThreadRewind, files: readonly File[]): FormData => {
  const form = new FormData();
  form.set(CHAT_THREAD_FORM.messageId, input.messageId);
  form.set(CHAT_THREAD_FORM.text, input.text);
  if (input.model) form.set(CHAT_THREAD_FORM.model, input.model);
  if (input.effort) form.set(CHAT_THREAD_FORM.effort, input.effort);
  for (const id of input.drop ?? []) form.append(CHAT_THREAD_FORM.drop, id);
  for (const file of files) form.append(CHAT_THREAD_FORM.attachment, file);
  return form;
};

const account = (accountId: string, path = ''): string => `/api/organizations/${encodeURIComponent(accountId)}${path}`;
const segment = (value: string): string => encodeURIComponent(value);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const put = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const remove = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
/** Sends a file as its body, the bytes it is, under its own media type. */
const sendFile = <T>(path: string, method: 'POST' | 'PUT', file: Blob): Promise<T> =>
  request<T>(path, { method, body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });

/** Where one file of a Skill's current folder is read; the session cookie authorises it. */
const skillFileUrl = (accountId: string, skillId: string, path: string): string =>
  account(accountId, `/skills/${segment(skillId)}/file?path=${encodeURIComponent(path)}`);

let bootstrapInFlight: Promise<AppState> | undefined;
const bootstrap = (): Promise<AppState> => {
  if (bootstrapInFlight) return bootstrapInFlight;
  const requestPromise = request<AppState>('/api/bootstrap');
  bootstrapInFlight = requestPromise;
  void requestPromise.then(
    () => { if (bootstrapInFlight === requestPromise) bootstrapInFlight = undefined; },
    () => { if (bootstrapInFlight === requestPromise) bootstrapInFlight = undefined; },
  );
  return requestPromise;
};

export const api = {
  bootstrap,
  /** Starts Google sign-in, returning afterwards to the page named, else to the start. */
  beginGoogleLogin: (returnTo?: string): Promise<{ authorizationUrl: string }> => post('/api/entry/google', returnTo ? { returnTo } : {}),
  previewAuthorization: (query: string): Promise<AuthorizationPreview> => post('/api/oauth/authorizations/preview', { query }),
  decideAuthorization: (query: string, accountId: string, approve: boolean): Promise<AuthorizationDecision> =>
    post('/api/oauth/authorizations', { query, accountId, approve }),
  /** Signs one Google account out of this browser, the current one unless another is named, or every one. */
  logout: (input: { identityId?: string; everyone?: boolean } = {}): Promise<{ loggedOut: boolean; remaining: number }> => post('/api/auth/logout', input),
  /** Makes another Google account signed in on this browser its current person. */
  switchPerson: (identityId: string): Promise<{ switched: boolean }> => post('/api/auth/switch', { identityId }),
  presets: (): Promise<Preset[]> => request('/api/presets'),
  startAccount: (): Promise<{ accepted: boolean }> => post('/api/onboarding/start', {}),
  retryOnboarding: (): Promise<{ accepted: boolean }> => post('/api/onboarding/retry'),
  cancelOnboarding: (): Promise<{ cancelled: boolean }> => remove('/api/onboarding'),

  joinContactPage: (accountId: string, token: string): Promise<{ contactId: string; name: string }> => post(`/api/member-links/${segment(accountId)}/${segment(token)}`, {}),
  contactPage: (): Promise<ContactPage> => request('/api/portal'),
  registerContactAttendance: (eventId: string, input: { status: AttendanceStatus; comment: string }): Promise<{ eventId: string }> => put(`/api/portal/events/${segment(eventId)}/attendance`, input),

  currentAutomation: (accountId: string): Promise<AutomationStatus | null> => request(account(accountId, '/automation')),
  reauthorizeAutomationInbox: (accountId: string): Promise<{ authorizationUrl: string }> => post(account(accountId, '/automation/reauthorize')),
  dashboard: (accountId: string): Promise<Dashboard> => request(account(accountId, '/dashboard')),
  guestRegistrations: (accountId: string): Promise<GuestRegistrationRoster[]> => request(account(accountId, '/guest-registrations')),
  events: (accountId: string, view: 'upcoming' | 'past' = 'upcoming'): Promise<EventOverview[]> => request(account(accountId, view === 'past' ? '/events?view=past' : '/events')),
  event: (accountId: string, eventId: string): Promise<EventDetail> => request(account(accountId, `/events/${segment(eventId)}`)),

  skills: (accountId: string): Promise<Skill[]> => request(account(accountId, '/skills')),
  /** Makes a Skill from its SKILL.md, sent as the file it is. */
  createSkill: (accountId: string, document: Blob): Promise<Skill> => sendFile(account(accountId, '/skills'), 'POST', document),
  /** Writes one file of a Skill as its bytes, over whatever it held. */
  writeSkillFile: (accountId: string, skillId: string, path: string, file: Blob): Promise<Skill> => sendFile(skillFileUrl(accountId, skillId, path), 'PUT', file),
  removeSkillFile: (accountId: string, skillId: string, path: string): Promise<Skill> => remove(skillFileUrl(accountId, skillId, path)),
  /** Moves a file, or a folder and everything in it, as renaming it does. */
  moveSkillFiles: (accountId: string, skillId: string, move: SkillFileMove): Promise<Skill> => post(account(accountId, `/skills/${segment(skillId)}/move`), move),
  skillFileUrl,
  /** One file of a Skill, as the bytes it is kept as. */
  skillFile: async (accountId: string, skillId: string, path: string): Promise<Blob> => {
    const response = await fetch(skillFileUrl(accountId, skillId, path), { credentials: 'include' });
    if (!response.ok) throw new ApiError((await responseBody<never>(response))?.error ?? {}, response.status);
    return response.blob();
  },
  memories: (accountId: string): Promise<MemoryList> => request(account(accountId, '/memories')),
  /** The same search an AI's memory.search makes; the words are sent in the body, not the address. */
  searchMemories: (accountId: string, query: string): Promise<MemorySearch> => post(account(accountId, '/memories/search'), { query }),
  /** Why the Account remembers it: the words it rests on, as they were said, and every change since. */
  memory: (accountId: string, memoryId: string): Promise<MemoryDetail> => request(account(accountId, `/memories/${segment(memoryId)}`)),
  saveMemory: (accountId: string, content: string): Promise<Memory> => post(account(accountId, '/memories'), { content }),
  updateMemory: (accountId: string, memoryId: string, content: string): Promise<Memory> => put(account(accountId, `/memories/${segment(memoryId)}`), { content }),
  eraseMemory: (accountId: string, memoryId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/memories/${segment(memoryId)}`)),
  removeSkill: (accountId: string, skillId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/skills/${segment(skillId)}`)),
  applyPreset: (accountId: string, presetId: string, conflictPolicy?: 'duplicate'): Promise<PresetApplication> => post(account(accountId, `/presets/${segment(presetId)}/apply`), conflictPolicy ? { conflictPolicy } : {}),

  exceptions: (accountId: string): Promise<AutomationException[]> => request(account(accountId, '/operations/exceptions')),
  resolveException: (accountId: string, id: string): Promise<{ id: string }> => patch(account(accountId, `/operations/exceptions/${segment(id)}`), { action: 'resolve' }),
  warnings: (accountId: string): Promise<AutomationWarning[]> => request(account(accountId, '/automation-warnings')),
  stuckJobs: (accountId: string): Promise<StuckJob[]> => request(account(accountId, '/operations/jobs')),
  setSuspension: (accountId: string, suspended: boolean): Promise<{ accountId: string; status: string }> => patch(account(accountId, '/suspension'), { suspended }),
  deliveries: (accountId: string): Promise<DeliveryRecord[]> => request(account(accountId, '/audit/deliveries')),


  connections: (accountId: string): Promise<Connections> => request(account(accountId, '/connections')),
  saveLineConnection: (accountId: string, input: { channelAccessToken?: string | undefined; channelSecret?: string | undefined }): Promise<Connections['line']> => put(account(accountId, '/connections/line'), input),
  saveAiConnection: (accountId: string, input: { provider: AiProvider; apiKey?: string | undefined; model?: string | undefined; models?: string[] | undefined }): Promise<Connections['ai']> => put(account(accountId, '/connections/ai'), input),
  saveTranscriptionConnection: (accountId: string, input: { apiKey?: string | undefined; model?: string | undefined }): Promise<Connections['transcription']> => put(account(accountId, '/connections/transcription'), input),
  removeTranscriptionConnection: (accountId: string): Promise<Connections['transcription']> => remove(account(accountId, '/connections/transcription')),
  connectMicrosoft: (accountId: string): Promise<{ authorizationUrl: string }> => post(account(accountId, '/connections/microsoft/authorize')),
  disconnectMicrosoft: (accountId: string): Promise<Connections['microsoft']> => remove(account(accountId, '/connections/microsoft')),
  testAiConnection: (accountId: string, prompt: string): Promise<{ text: string; model: string }> => post(account(accountId, '/connections/ai/test'), { prompt }),
  saveDiscordConnection: (accountId: string, input: { botToken: string; applicationPublicKey: string }): Promise<{ configured: boolean; interactionsUrl: string }> => put(account(accountId, '/connections/discord'), input),
  transcripts: (accountId: string): Promise<TranscriptList> => request(account(accountId, '/transcripts')),
  transcript: (accountId: string, transcriptId: string): Promise<TranscriptDetail> => request(account(accountId, `/transcripts/${segment(transcriptId)}`)),
  uploadRecording: (accountId: string, file: File): Promise<TranscriptSummary> => postForm(account(accountId, '/transcripts'), recordingForm(file)),
  renameTranscript: (accountId: string, transcriptId: string, title: string): Promise<TranscriptSummary> => patch(account(accountId, `/transcripts/${segment(transcriptId)}`), { title }),
  removeTranscript: (accountId: string, transcriptId: string): Promise<{ id: string; deleted: boolean }> => remove(account(accountId, `/transcripts/${segment(transcriptId)}`)),
  transcribeAgain: (accountId: string, transcriptId: string): Promise<TranscriptSummary> => post(account(accountId, `/transcripts/${segment(transcriptId)}/transcribe`)),
  writeMinutes: (accountId: string, transcriptId: string, input: MinutesInput): Promise<TranscriptDetail> => post(account(accountId, `/transcripts/${segment(transcriptId)}/minutes`), input),
  /** Where the recording is played from: an address the browser opens with the session's cookie. */
  recordingUrl: (accountId: string, transcriptId: string): string => account(accountId, `/transcripts/${segment(transcriptId)}/recording`),
  driveFolders: (accountId: string): Promise<DriveFolders> => request(account(accountId, '/drive-folders')),
  browserSettings: (accountId: string): Promise<BrowserSettings> => request(account(accountId, '/browser')),
  setBrowserEnabled: (accountId: string, enabled: boolean): Promise<BrowserSettings> => put(account(accountId, '/browser'), { enabled, timeZone: browserZone() }),
  setBrowserTimeZone: (accountId: string, timeZone: string): Promise<BrowserSettings> => put(account(accountId, '/browser/time-zone'), { timeZone }),
  beginBrowserSignIn: (accountId: string, url: string): Promise<BrowserSignIn> => post(account(accountId, '/browser/logins'), { url, timeZone: browserZone() }),
  saveBrowserSignIn: (accountId: string, loginId: string): Promise<BrowserLogin> => post(account(accountId, `/browser/logins/${segment(loginId)}/save`), {}),
  cancelBrowserSignIn: (accountId: string, loginId: string): Promise<{ id: string; cancelled: true }> => post(account(accountId, `/browser/logins/${segment(loginId)}/cancel`), {}),
  removeBrowserLogin: (accountId: string, loginId: string): Promise<{ id: string; deleted: true }> => remove(account(accountId, `/browser/logins/${segment(loginId)}`)),
  addDriveFolder: (accountId: string, link: string): Promise<DriveFolders> => post(account(accountId, '/drive-folders'), { link }),
  removeDriveFolder: (accountId: string, folderId: string): Promise<DriveFolders> => remove(account(accountId, `/drive-folders/${segment(folderId)}`)),

  contacts: (accountId: string): Promise<Contact[]> => request(account(accountId, '/members')),
  createContact: (accountId: string, input: ContactInput): Promise<Contact> => post(account(accountId, '/members'), input),
  updateContact: (accountId: string, contactId: string, input: ContactUpdate): Promise<Partial<Contact> & { id: string }> => patch(account(accountId, `/members/${segment(contactId)}`), input),
  deleteContact: (accountId: string, contactId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/members/${segment(contactId)}`)),
  setContactLineHandle: (accountId: string, contactId: string, input: LineHandleInput): Promise<LineHandle> => put(account(accountId, `/members/${segment(contactId)}/line-destination`), input),
  removeContactLineHandle: (accountId: string, contactId: string, lineDestinationId: string): Promise<{ id: string; unlinked: boolean }> => remove(account(accountId, `/members/${segment(contactId)}/line-destination/${segment(lineDestinationId)}`)),
  lineHandles: (accountId: string): Promise<LineHandleRecord[]> => request(account(accountId, '/line-destinations')),
  registerLineHandle: (accountId: string, input: LineHandleInput): Promise<LineHandleRecord> => post(account(accountId, '/line-destinations'), input),
  removeLineHandle: (accountId: string, lineDestinationId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/line-destinations/${segment(lineDestinationId)}`)),
  contactImportPreview: (accountId: string, csv: string): Promise<ContactImportPreview> => post(account(accountId, '/members/import/preview'), { csv }),
  importContacts: (accountId: string, csv: string): Promise<ContactImportResult> => post(account(accountId, '/members/import'), { csv }),
  contactExportUrl: (accountId: string): string => account(accountId, '/members/export'),
  channelTestTargets: (accountId: string): Promise<ChannelTestTarget[]> => request(account(accountId, '/channel-tests/targets')),
  sendChannelTest: (accountId: string, input: { contactId: string; channel: string; texts: string[] }): Promise<ChannelTestDelivery> => post(account(accountId, '/channel-tests'), input),
  contactLists: (accountId: string): Promise<ContactList[]> => request(account(accountId, '/contact-lists')),
  saveContactList: (accountId: string, id: string, input: ContactListInput): Promise<{ id: string }> => put(account(accountId, `/contact-lists/${segment(id)}`), input),


  mcpServers: (accountId: string): Promise<McpServer[]> => request(account(accountId, '/mcp-servers')),
  saveMcpServer: (accountId: string, id: string, input: McpServerInput): Promise<{ id: string }> => put(account(accountId, `/mcp-servers/${segment(id)}`), input),
  removeMcpServer: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/mcp-servers/${segment(id)}`)),
  /** Where the person signs this Account in to an MCP Server by OAuth; the server sends them back to 接続. */
  authorizeMcpServer: (accountId: string, id: string): Promise<{ authorizationUrl: string }> => post(account(accountId, `/mcp-servers/${segment(id)}/authorize`)),
  listMcpServerTools: (accountId: string, serverId: string): Promise<{ server: string; tools: McpServerTool[] }> => post(account(accountId, `/mcp-servers/${segment(serverId)}/tests`), {}),
  callMcpServerTool: (accountId: string, serverId: string, input: { tool: string; arguments: Record<string, unknown> }): Promise<McpServerToolResult> => post(account(accountId, `/mcp-servers/${segment(serverId)}/tests`), input),
  /** The conversations of Operator Chat (ADR 0201), the one changed last first. */
  chatThreads: (accountId: string): Promise<ChatThread[]> => request(account(accountId, '/chat-threads')),
  createChatThread: (accountId: string): Promise<ChatThread> => post(account(accountId, '/chat-threads')),
  /** Sends a message with its files, handed to the answer being written or queued after it as `delivery` says. */
  sendChatThreadMessage: (accountId: string, threadId: string, input: ChatThreadMessage, files: readonly File[] = []): Promise<ChatThreadDispatch> =>
    postForm(account(accountId, `/chat-threads/${segment(threadId)}/messages`), threadMessageForm(input, files)),
  /** Sends a queued message now, removes it, rewrites it, or moves it. */
  changeChatThreadQueue: (accountId: string, threadId: string, input: ChatThreadQueue): Promise<ChatThreadDispatch> =>
    post(account(accountId, `/chat-threads/${segment(threadId)}/queue`), input),
  interruptChatThread: (accountId: string, threadId: string): Promise<ChatThreadDispatch> => post(account(accountId, `/chat-threads/${segment(threadId)}/interrupt`)),
  answerChatThreadApproval: (accountId: string, threadId: string, input: ChatThreadApproval): Promise<ChatThreadDispatch> =>
    post(account(accountId, `/chat-threads/${segment(threadId)}/approvals`), input),
  chatThreadModes: (accountId: string, threadId: string): Promise<ChatThreadModes> => request(account(accountId, `/chat-threads/${segment(threadId)}/mode`)),
  /** What the member is likely to write next after the conversation's latest answer, which its composer shows greyed. */
  chatThreadSuggestion: (accountId: string, threadId: string): Promise<ChatThreadSuggestion> => request(account(accountId, `/chat-threads/${segment(threadId)}/suggestion`)),
  setChatThreadMode: (accountId: string, threadId: string, input: ChatThreadMode): Promise<ChatThreadDispatch> =>
    put(account(accountId, `/chat-threads/${segment(threadId)}/mode`), input),
  /** Where a conversation's stream is opened, as a WebSocket address on this page's own origin. */
  chatThreadStreamUrl: (accountId: string, threadId: string, afterSequence: number, page: string = window.location.href): string => {
    const url = new URL(account(accountId, `/chat-threads/${segment(threadId)}/stream`), page);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('afterSequence', String(afterSequence));
    return url.toString();
  },
  /** Where a file an answer of a conversation kept is read; the session cookie authorises it. */
  chatThreadFileUrl: (accountId: string, threadId: string, fileId: string): string =>
    account(accountId, `/chat-threads/${segment(threadId)}/files/${segment(fileId)}`),
  /** Renames a conversation; its place in the list stays. */
  renameChatThread: (accountId: string, threadId: string, input: ChatThreadRename): Promise<ChatThread> =>
    patch(account(accountId, `/chat-threads/${segment(threadId)}`), input),
  /** Deletes a conversation, stopping the answer being written first. */
  deleteChatThread: (accountId: string, threadId: string): Promise<ChatThreadDeleted> => remove(account(accountId, `/chat-threads/${segment(threadId)}`)),
  /** Rewinds a conversation to an earlier message and asks it again as rewritten, with the files it keeps and those added. */
  rewindChatThread: (accountId: string, threadId: string, input: ChatThreadRewind, files: readonly File[] = []): Promise<ChatThreadDispatch> =>
    postForm(account(accountId, `/chat-threads/${segment(threadId)}/rewind`), threadRewindForm(input, files)),
  /** Continues a conversation from one of its answers as a new conversation. */
  forkChatThread: (accountId: string, threadId: string, runId: string): Promise<ChatThread> =>
    post(account(accountId, `/chat-threads/${segment(threadId)}/fork`), { runId }),
  /** The models a message may be answered by, the levels of effort each takes, and whether Google Picker is configured. */
  chatCapabilities: (accountId: string): Promise<ChatCapabilities> => request(account(accountId, '/chat-capabilities')),
  /** What Google Picker is opened with, or null where it is not configured. */
  chatDrivePicker: (accountId: string): Promise<ChatDrivePicker | null> => post(account(accountId, '/chat-drive-picker')),
  /** Saves a file of a conversation to Drive, in the folder chosen or in AI に聞く. */
  saveChatFileToDrive: (accountId: string, threadId: string, fileId: string, input: ChatDriveSave): Promise<ChatDriveSaved> =>
    post(account(accountId, `/chat-threads/${segment(threadId)}/files/${segment(fileId)}/drive`), input),
  /** A Drive file a member picked, as the file itself, to attach to a message. */
  chatDriveFile: async (accountId: string, fileId: string): Promise<File> => {
    const response = await fetch(account(accountId, `/chat-drive-files/${segment(fileId)}`), { credentials: 'include' });
    if (!response.ok) throw new ApiError((await responseBody<null>(response).catch(() => null))?.error ?? {}, response.status);
    const named = /filename\*=UTF-8''([^;]+)/u.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
    const blob = await response.blob();
    return new File([blob], named ? decodeURIComponent(named) : 'Drive のファイル', { type: response.headers.get('Content-Type') ?? blob.type });
  },
  /** Whether this OrangeAgent can notify, with the key a browser subscribes with. */
  pushSettings: (accountId: string): Promise<PushSettings> => request(account(accountId, '/push')),
  /** Notifies the signed-in member on this browser from now on. */
  savePushDevice: (accountId: string, input: PushDevice): Promise<PushDeviceState> => post(account(accountId, '/push/devices'), input),
  /** Stops notifying the signed-in member on the browser that subscribed with `endpoint`. */
  removePushDevice: (accountId: string, endpoint: string): Promise<PushDeviceState> => remove(account(accountId, '/push/devices'), { endpoint }),
  accessTokens: (accountId: string): Promise<AccessToken[]> => request(account(accountId, '/access-tokens')),
  issueAccessToken: (accountId: string, input: AccessTokenInput): Promise<IssuedAccessToken> => post(account(accountId, '/access-tokens'), input),
  revokeAccessToken: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/access-tokens/${segment(id)}`)),
  operatorTokens: (accountId: string): Promise<OperatorToken[]> => request(account(accountId, '/operator-tokens')),
  mcpEndpoint: (accountId: string): Promise<McpEndpoint> => request(account(accountId, '/mcp-endpoint')),
  issueLoginCode: (accountId: string): Promise<IssuedLoginCode> => post(account(accountId, '/login-codes')),
  revokeOperatorToken: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/operator-tokens/${segment(id)}`)),
  automations: (accountId: string): Promise<Automation[]> => request(account(accountId, '/automations')),
  automation: (accountId: string, id: string): Promise<Automation> => request(account(accountId, `/automations/${segment(id)}`)),
  createAutomation: (accountId: string, input: AutomationInput): Promise<Automation> => post(account(accountId, '/automations'), input),
  updateAutomation: (accountId: string, id: string, input: AutomationUpdate): Promise<Automation> => patch(account(accountId, `/automations/${segment(id)}`), input),
  removeAutomation: (accountId: string, id: string): Promise<{ id: string; deleted: boolean }> => remove(account(accountId, `/automations/${segment(id)}`)),
  tryAutomation: (accountId: string, id: string): Promise<AutomationTrial> => post(account(accountId, `/automations/${segment(id)}/trial`)),
  runs: (accountId: string, automationId?: string): Promise<Run[]> => request(account(accountId, automationId ? `/runs?automationId=${encodeURIComponent(automationId)}` : '/runs')),
  decideRun: (accountId: string, runId: string, decision: 'approve' | 'reject'): Promise<Run> => post(account(accountId, `/runs/${segment(runId)}/decision`), { decision }),
  runTranscript: (accountId: string, runId: string): Promise<RunTranscript> => request(account(accountId, `/runs/${segment(runId)}/transcript`)),
};

export type Api = typeof api;
