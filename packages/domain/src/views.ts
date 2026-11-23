import type { AiProvider } from './environment';

/**
 * The views the Worker's routes return and the GUI reads.
 *
 * Each is declared here once, named as CONTEXT.md names the concept, so a
 * field added on one side reaches the other at compile time or fails there.
 */

import type { ChatApproval, ChatMode } from './approvals';
import type { ModelEffort, ModelEfforts } from './models';

export interface ApiResult<T> {
  data: T;
}

/** What a failed route says about itself, beyond its status. */
export interface ApiErrorDetails {
  message?: string;
  code?: string;
  category?: string;
  databaseKind?: 'control' | 'organization';
  databaseId?: string | null;
  bindingName?: string;
  currentMigration?: string;
  expectedMigration?: string;
  requestId?: string;
}

export interface ApiFailure {
  error?: ApiErrorDetails;
}

export type ExecutionMode = 'read_only' | 'approval' | 'unattended';
/** How long a repeat of the same write from the same Automation is withheld. */
export type SuppressionWindow = 'none' | 'hour' | 'day' | 'week' | 'forever';
export type AttendanceStatus = 'unanswered' | 'attending' | 'not_attending';
export type LineHandleKind = 'user' | 'group' | 'room';

export interface AccountMembership {
  accountId: string;
  name: string;
  status: string;
}

/** The Automation Inbox as it stands: its grant, and whether it keeps failing to refresh. */
export interface AutomationStatus {
  email: string;
  displayName: string;
  status: 'active' | 'reauthentication_required' | 'disconnected';
  lastError: string | null;
  /** Set while the grant keeps failing to refresh; the Worker keeps retrying until it clears. */
  failingSince: string | null;
  /** Whether the grant lets OrangeAgent save Gmail drafts; one given before drafts existed does not until the Inbox is reconnected. */
  draftsGranted: boolean;
  /** Whether the grant lets OrangeAgent reach the whole Drive; one given before it did does not until the Inbox is reconnected. */
  driveGranted: boolean;
  /** Whether the grant lets OrangeAgent read Meet transcripts and transcribe meetings; one given before it did does not until the Inbox is reconnected. */
  meetGranted: boolean;
  /** Whether the grant lets OrangeAgent keep the Account's Tasks in Google Tasks; one given before it did does not until the Inbox is reconnected. */
  tasksGranted: boolean;
}

/** One Drive folder beneath which every run the Account starts reads and files, as it was named when it was added. */
export interface DriveFolder {
  id: string;
  name: string;
  url: string;
}

/** Where in the Drive runs reach: beneath these folders, or the whole Drive when there are none. */
export interface DriveFolders {
  folders: DriveFolder[];
}

/**
 * One condition that leaves something undelivered or undone until the Account
 * acts. Home lists each with a count and links it to the screen that
 * resolves it; `detail` names the first instance where one can be named.
 */
export type AttentionKind =
  | 'pending_approval'
  | 'failed_run'
  | 'exception'
  | 'reauthentication'
  | 'ai_missing'
  | 'unlinked_line'
  | 'stuck_job'
  | 'warning';

export interface Attention {
  kind: AttentionKind;
  count: number;
  detail: string;
}

/** A Scheduled Event still ahead, with how its Eligible Recipients have answered. */
export interface UpcomingEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  attending: number;
  notAttending: number;
  unanswered: number;
  responseDeadline: string | null;
}

/** A Scheduled Event as the 予定 tab lists it: when, where, and how it was answered. */
export interface EventOverview {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  status: 'scheduled' | 'cancelled';
  responseDeadline: string | null;
  attending: number;
  notAttending: number;
  unanswered: number;
  /** Guest Registrations attending, counted apart from the Account's own Contacts. */
  guestsAttending: number;
  /** The Source Message it came from, by subject, when it came from one. */
  sourceSubject: string | null;
}

/** One Eligible Recipient's Attendance Registration. */
export interface RegistrationView {
  contactId: string;
  name: string;
  status: AttendanceStatus;
  comment: string;
  updatedAt: string;
}

/** One Scheduled Event in full: each registration, its guests, and the Source Message it came from. */
export interface EventDetail extends EventOverview {
  description: string;
  registrations: RegistrationView[];
  guests: Array<{ name: string; affiliation: string; attending: boolean }>;
  source: { subject: string; sender: string; receivedAt: string } | null;
}

/** One Automation as Home shows it: when it next runs and how its latest run ended. */
export type AutomationGlance = Pick<Automation, 'id' | 'name' | 'enabled' | 'schedule' | 'nextRunAt' | 'lastRun'>;

/** What Home shows: the Automations, what needs the Account, and what is next. */
export interface Dashboard {
  /** Every Automation that is not archived, the next to run first. */
  automations: AutomationGlance[];
  attention: Attention[];
  upcomingEvents: UpcomingEvent[];
}


export interface Connections {
  accountId: string;
  accountName: string;
  line: {
    channelAccessTokenConfigured: boolean;
    channelSecretConfigured: boolean;
    webhookUrl: string;
  };
  ai: {
    apiKeyConfigured: boolean;
    /** The default model, which Operator Chat answers with unless another is chosen and every Automation that names none thinks with. */
    model: string;
    /** Every model that can be chosen instead, the default first; no other model is ever called. */
    models: string[];
    /**
     * The API the Connection is on, which decides its Base URL, its protocol,
     * and where its model runs code; null when none is saved, or when it was
     * saved on another API before the four were the only ones.
     */
    provider: AiProvider | null;
  };
  /**
   * The OpenRouter key and model a recording sent to Operator Chat is
   * transcribed with, speaker by speaker. It is kept apart from the AI
   * Connection, which may be any API; without it, no recording is accepted.
   */
  transcription: {
    apiKeyConfigured: boolean;
    model: string;
  };
  /** The Microsoft account Word for the web renders PDFs through; without one, Google renders them. */
  microsoft: {
    /** Whether this deployment holds the Microsoft app's id and secret, without which no account can be connected. */
    configured: boolean;
    connected: boolean;
    email: string | null;
  };
}

/** The Guest Registrations on one Scheduled Event, as the Account reviews the roster. */
export interface GuestRegistrationRoster {
  eventId: string;
  title: string;
  startsAt: string;
  attendingCount: number;
  affiliations: Array<{ affiliation: string; attending: number }>;
  guests: Array<{ name: string; affiliation: string; attending: boolean }>;
}

/**
 * One of the Account's Skills: how it wants a kind of work done, kept as the
 * folder Claude's Agent Skills write. A run is started with the Skills it
 * names and told every other one by its description, to open when it applies.
 */
export interface Skill {
  id: string;
  accountId: string;
  /** As its SKILL.md's front matter states it, and the name of its directory: lowercase letters, digits, and hyphens (Agent Skills). */
  name: string;
  /** The name a person reads, as `metadata.display-name` in its SKILL.md states it, or its name when it states none. */
  title: string;
  /** When the Skill applies, as its SKILL.md's front matter states it and a run not started with it reads it. */
  description: string;
  /** Every file of its directory, SKILL.md among them, in path order. */
  files: SkillFile[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One file of a Skill's folder, named by its path within the folder, such as
 * `SKILL.md` or `examples/report.md`. It may be of any kind, and its bytes are
 * read on their own, as the file they are.
 */
export interface SkillFile {
  path: string;
  size: number;
  mediaType: string;
}

/** A file, or a folder and everything in it, moved to another path of the same Skill. */
export interface SkillFileMove {
  from: string;
  to: string;
}

export interface AutomationSettings {
  name: string;
  /** Whether it runs at its Trigger Time: on or off. One that is off can still be tried from its page. */
  enabled: boolean;
  /**
   * When it runs, read in Asia/Tokyo: `daily HH:MM`, `weekly ddd HH:MM`, or
   * `hourly :MM`.
   */
  schedule: string;
  executionMode: ExecutionMode;
  /** The Skills every run of it is started with, in order; at least one. Whom it tells is theirs to say. */
  skillIds: string[];
  /** Its Tool Grant: the tools its runs may call. */
  tools: string[];
  suppressionWindow: SuppressionWindow;
  /** The model its runs think with, one of those the AI Connection names; null for the Connection's default. */
  model: string | null;
}

/** An Automation: when it runs, the Skills it runs, and the tools it may call. */
export interface Automation extends AutomationSettings {
  id: string;
  /** Its Automation Revision, which every change to what its runs do renumbers. */
  revision: number;
  /** When it next runs; null for one that is off. */
  nextRunAt: string | null;
  /** Its latest run, when it has run. */
  lastRun: { id: string; startedAt: string; status: RunStatus; error: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** A new Automation. */
export type AutomationInput = AutomationSettings;

/** A change to an Automation. */
export type AutomationUpdate = Partial<AutomationSettings>;

export type PlannedWriteStatus = 'planned' | 'pending' | 'applying' | 'succeeded' | 'transient_failed' | 'permanent_failed' | 'blocked' | 'rejected' | 'expired';

/** One write a Run planned, frozen as the call it made and applied by the handler that performs that call. */
export interface PlannedWrite {
  id: string;
  key: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  status: PlannedWriteStatus;
  attempts: number;
  result: unknown | null;
  error: string | null;
}

export type RunStatus = 'planning' | 'read_only' | 'pending_approval' | 'applying' | 'completed' | 'rejected' | 'expired' | 'failed';

/**
 * What started a Run: an Automation's Trigger Time, or one exchange of
 * Operator Chat. A mail arriving and the Morning started runs before migration
 * 0042, whose records are kept.
 */
export type RunTrigger = 'schedule' | 'chat' | 'mail' | 'morning';

/** One Run: an Automation working on one Trigger, or one Operator Chat exchange. */
export interface Run {
  id: string;
  trigger: RunTrigger;
  /** The Automation and the revision it ran; null for an Operator Chat exchange. */
  automation: { id: string; name: string; revision: number } | null;
  sourceMessage: { id: string; subject: string; sender: string; receivedAt: string } | null;
  executionMode: ExecutionMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** When the approval it waits for expires. */
  expiresAt: string | null;
  model: string | null;
  toolCalls: number;
  tokens: number;
  /** What the model concluded, in its own words. */
  output: string | null;
  error: string | null;
  /** Whether its Run Transcript can still be read. */
  transcript: boolean;
  writes: PlannedWrite[];
}

/** What one Automation's run read and concluded, kept to explain a run that is never retried. */
export interface RunTranscript {
  runId: string;
  /** The Source Message a mail Automation read, or null for every other Trigger. */
  source: { subject: string; body: string; attachments: Array<{ filename: string; text: string }> } | null;
  /** What the run was asked. */
  request: string;
  messages: Array<{ role: string; content: string }>;
  finalOutput: string;
  error: string | null;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
}

export interface PresetApplication {
  presetId: string;
  skills: number;
  automations: number;
}

/** One Source Message withheld from every action until somebody looks at it. */
export interface AutomationException {
  id: string;
  sourceMessageId: string | null;
  code: string;
  message: string;
  state: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AutomationWarning {
  id: string;
  sourceMessageId: string;
  code: string;
  message: string;
  createdAt: string;
}

/** A Job that will not run itself: claimed and abandoned, or out of retries. */
export interface StuckJob {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  updatedAt: string;
}

export interface DeliveryRecord {
  id: string;
  eventId: string | null;
  sourceMessageId: string | null;
  channel: string;
  destination: string;
  outcome: string;
  externalId: string | null;
  createdAt: string;
}

/**
 * What one Automation would do if it ran now: its answer and every write it
 * planned, none of them applied and no Run recorded.
 */
export interface AutomationTrial {
  automation: { id: string; revision: number };
  model: string;
  output: string;
  toolCalls: number;
  tokens: number;
  planned: Array<{ tool: string; arguments: Record<string, unknown> }>;
  /** Why the run stopped, when it did; what it planned before then is still shown. */
  error: string | null;
}

/** A LINE Channel Handle as it hangs on one Contact. */
export interface LineHandle {
  id: string;
  destinationId: string;
  displayName: string;
  kind: LineHandleKind;
  status: 'discovered' | 'disabled';
  source: 'webhook' | 'manual';
}

/** A LINE Channel Handle in the Account's pool, whether or not a Contact holds it yet. */
export interface LineHandleRecord extends LineHandle {
  discoveredAt: string;
  contactId: string | null;
}

export interface LineHandleInput {
  destinationId: string;
  kind?: LineHandleKind;
  displayName?: string;
}

export interface Contact {
  id: string;
  accountId: string;
  name: string;
  email: string;
  state: 'active' | 'inactive';
  /** What kind of Contact this is, in the Account's own words. */
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lineDestinations: LineHandle[];
}

export interface ContactInput {
  name: string;
  email?: string;
  description?: string;
  tags?: string[];
  lineDestinationId?: string;
}

export type ContactUpdate = Partial<Pick<Contact, 'name' | 'email' | 'description' | 'tags' | 'state'>>;

/** A CSV line the import passes over, and why: its Contact is already in the roster or earlier in the file. */
export interface ContactImportSkip {
  line: number;
  name: string;
  email: string;
  reason: string;
}

/** What importing a Contact CSV would do, read before anything is written. */
export interface ContactImportPreview {
  accepted: Array<{ line: number; name: string; email: string; description: string; tags: string[] }>;
  skipped: ContactImportSkip[];
  invalid: Array<{ line: number; text: string; reason: string }>;
}

/** What importing a Contact CSV did. */
export interface ContactImportResult extends ContactImportPreview {
  imported: number;
}

/** One Contact a test message can actually be sent to, and on which Channels. */
export interface ChannelTestTarget {
  id: string;
  name: string;
  email: string;
  state: string;
  channels: string[];
}

export interface ChannelTestDelivery {
  delivered: boolean;
  channel: string;
  contactId: string;
  destination: string;
  /** How many messages were meant to arrive, and how many provider requests carried them. */
  messages: number;
  requests: number;
  externalId: string | null;
  sentAt: string;
}

/** How an MCP Server is called: with nothing, the static token entered for it, or the OAuth grant the Account signed in to. */
export type McpAuthentication = 'none' | 'token' | 'oauth';

export interface McpServer {
  id: string;
  name: string;
  url: string;
  revision: string | null;
  authentication: McpAuthentication;
  /** Whether it is signed in to with an OAuth client the Account registered itself. */
  ownOAuthClient: boolean;
  /** Why signing in to it last failed, or why its grant stopped working; null while nothing needs doing. */
  signInError: string | null;
  updatedAt: string;
}

/**
 * One site the Account's browser is signed in to: a person signed in once
 * through Browser Run's Live View, and every run's browser starts signed in
 * as they left it (ADR 0200).
 */
export interface BrowserLogin {
  id: string;
  /** The host the person began signing in at, such as `www.example.com`. */
  site: string;
  /** Where the person began signing in. */
  url: string;
  /** Whether a person is signing in now, in a Live View that has not been saved. */
  signingIn: boolean;
  /** When the sign-in was last saved, or null before it first is. */
  savedAt: string | null;
  /** When a run last used it, or null before one has. */
  usedAt: string | null;
}

/** The ブラウザ screen: whether runs may operate a browser, and the sites it is signed in to. */
export interface BrowserSettings {
  /** Whether the Account lets its runs operate a browser. */
  enabled: boolean;
  /** Whether this Worker has a Browser Run binding at all. */
  available: boolean;
  /** The IANA zone the Browser's clock reads in, or null until one is set; the Browser then reads Asia/Tokyo. */
  timeZone: string | null;
  logins: BrowserLogin[];
}

/** A sign-in begun: the login and the Live View a person signs in through. */
export interface BrowserSignIn {
  login: BrowserLogin;
  liveViewUrl: string;
  /** When the Live View, and the browser behind it, stop waiting. */
  expiresAt: string;
}

/**
 * An OAuth client the Account registered itself with a server's authorization
 * server, for one that registers no client on request (Google's Workspace MCP
 * servers). Without it, OrangeAgent registers itself when signing in.
 */
export interface McpOAuthClient {
  clientId: string;
  clientSecret: string | null;
  /** The scopes to ask for, space-separated; null asks for what the server names. */
  scope: string | null;
}

export interface McpServerInput {
  name: string;
  url: string;
  token: string | null;
  oauthClient?: McpOAuthClient | null;
}

export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerToolResult {
  server: string;
  tool: string;
  isError: boolean;
  text: string;
}

export interface ContactList {
  id: string;
  name: string;
  description: string;
  contactIds: string[];
}

export interface ContactListInput {
  name: string;
  contactIds: string[];
}

export interface AccessToken {
  id: string;
  name: string;
  contactListId: string;
  suppressionWindow: string;
  lastUsedAt: string | null;
  tools: string[];
}

export interface AccessTokenInput {
  name: string;
  contactListId: string;
  tools: string[];
  suppressionWindow: string;
}

/** The credential exactly once, because only its hash is kept. */
export interface IssuedAccessToken {
  id: string;
  name: string;
  tools: string[];
  token: string;
  url: string;
}

/** A member's CLI or OAuth client signed in with an Operator Token, as the 接続 screen lists it. */
export interface OperatorToken {
  id: string;
  /** The Google account of the member who was shown its Login Code or approved its client. */
  email: string;
  /** The name an OAuth client registered under, such as Claude, or null for a CLI signed in with a Login Code. */
  client: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** A Login Code, shown once to the signed-in member who asked for it. */
export interface IssuedLoginCode {
  code: string;
  expiresAt: string;
  /** Where a CLI exchanges the code for an Operator Token. */
  exchangeUrl: string;
  /** The MCP Server the Operator Token is presented to. */
  serverUrl: string;
}

/** Where an app or a CLI reaches the Account's MCP Server. */
export interface McpEndpoint {
  url: string;
}

/** One Account a member may let an OAuth client act on, with the Google account signed in on this browser that owns it. */
export interface AuthorizationAccount {
  accountId: string;
  name: string;
  email: string;
}

/**
 * What the authorization screen shows for a client's request: what to ask the
 * signed-in member, or where to send the browser back to the client, or why
 * the request cannot go anywhere.
 */
export type AuthorizationPreview =
  | {
    kind: 'ask';
    /** The name the client registered under. */
    client: string;
    /** Where the client receives the answer, so the member can see who is asking. */
    redirectHost: string;
    /** Every Account a person signed in here may choose; one when the client named its MCP Server. */
    accounts: AuthorizationAccount[];
    /** When a grant approved now ends. */
    expiresAt: string;
  }
  /** The client named an MCP Server whose owner, or anyone with an Account, is not signed in on this browser; signing them in returns here. */
  | { kind: 'sign_in'; client: string }
  | { kind: 'refused'; location: string }
  | { kind: 'unsafe'; message: string };

/** Where the browser goes once the member has approved or declined. */
export interface AuthorizationDecision {
  location: string;
}

/** What a CLI receives for a Login Code: the credential exactly once, and where to present it. */
export interface OperatorTokenGrant {
  token: string;
  expiresAt: string;
  /** The MCP Server the Token is presented to. */
  url: string;
}

/**
 * A conversation of Operator Chat (ADR 0201), as its list shows it. `title` is
 * empty until its first message names it.
 */
export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a message sent to a conversation of Operator Chat while an answer is
 * being written reaches it: handed to that answer at its next step, or queued
 * to be answered after it.
 */
export type ChatDelivery = 'steer' | 'queue';

/**
 * A message a member sends to a conversation of Operator Chat, as the
 * fields of its form (`CHAT_THREAD_FORM`), each file it carries a part of its own.
 */
export interface ChatThreadMessage {
  text: string;
  /** One of the models the AI Connection names to answer with; left out, its default. */
  model?: string;
  /** How hard the model thinks, one of the levels it takes; left out, its default. */
  effort?: ModelEffort;
  /** Left out, a message sent while an answer is written is handed to it. */
  delivery?: ChatDelivery;
}

/** What a member does to a queued message of Operator Chat: send it now, remove it, rewrite it, or move it before another (or last). */
export type ChatThreadQueue =
  | { action: 'send'; runId: string }
  | { action: 'remove'; runId: string }
  | { action: 'edit'; runId: string; text: string }
  | { action: 'move'; runId: string; beforeRunId: string | null };

/** What sending a message or stopping an answer of Operator Chat did; what follows arrives on the conversation's stream. */
export interface ChatThreadDispatch {
  threadId: string;
  /** False when nothing was done: a stop with nothing writing, an answer to a call no longer waiting, or a message no longer queued. */
  accepted: boolean;
}

/** A conversation's approval mode, as its composer sets it. */
export interface ChatThreadMode {
  mode: ChatMode;
}

/** The approval modes a conversation's composer offers, read-only first: 自動 only where the Worker can ask a Decider. */
export interface ChatThreadModes {
  modes: ChatMode[];
}

/**
 * What the member is likely to write next, greyed in the empty composer until they type: predicted
 * for the conversation's latest answer `runId` once it completed, or null with no answer to follow.
 */
export interface ChatThreadSuggestion {
  runId: string | null;
  text: string | null;
}

/** A conversation's new name, as a member gives it on its screen or in the list of conversations. */
export interface ChatThreadRename {
  title: string;
}

/**
 * Rewinding a conversation to an earlier message of a member's and asking it
 * again as `text` says: the answer it began and every answer after it are
 * taken back. The files it was sent with go with it again but those `drop`
 * names, and any file sent with the rewrite is added after them.
 */
export interface ChatThreadRewind {
  /** The message as the conversation's stream names it. */
  messageId: string;
  text: string;
  /** The ids of the files the message was sent with that the rewrite leaves out; left out, it keeps them all. */
  drop?: string[];
  /** One of the models the AI Connection names to answer with; left out, its default. */
  model?: string;
  /** How hard the model thinks, one of the levels it takes; left out, its default. */
  effort?: ModelEffort;
}

/** Continuing a conversation from one of its answers as a new conversation holding everything up to it. */
export interface ChatThreadFork {
  /** The answer, by the Run the conversation's stream names it by. */
  runId: string;
}

/** What deleting a conversation of Operator Chat did. */
export interface ChatThreadDeleted {
  id: string;
  deleted: boolean;
}

/**
 * What Operator Chat offers a member beyond writing: the models a message may
 * be answered by, the AI Connection's default first (empty with no AI
 * Connection), the levels of effort each takes, the lightest first, and the
 * one it thinks at when none is named (a model left out takes no choice of
 * effort), and whether Google Picker is
 * configured, so a file can be attached from Drive and saved in a Drive folder
 * the member chooses.
 */
export interface ChatCapabilities {
  models: string[];
  efforts: Record<string, ModelEfforts>;
  drivePicker: boolean;
}

/**
 * What the screen needs to open Google Picker: the deployment's API key and
 * app id, and a short-lived token of the Automation Inbox narrowed to
 * `drive.file`, which reaches only the files this application made or a
 * member picked, and nothing else.
 */
export interface ChatDrivePicker {
  apiKey: string;
  appId: string;
  accessToken: string;
}

/** Saving a file of a conversation to Drive: in the folder chosen with Google Picker, or, without one, in OrangeAgent's AI に聞く folder. */
export interface ChatDriveSave {
  folderId?: string;
}

/** Where a file of a conversation was saved in Drive. */
export interface ChatDriveSaved {
  fileId: string;
  url: string;
}

/** A person's answer to a call of Operator Chat waiting for approval; feedback, given with a decline, is told to the model. */
export interface ChatThreadApproval {
  requestId: string;
  decision: ChatApproval;
  feedback?: string;
}

/**
 * Whether Operator Chat can notify on this deployment: the VAPID public
 * key a browser subscribes with, or null when the Worker holds no VAPID keys
 * and no notification is sent.
 */
export interface PushSettings {
  publicKey: string | null;
}

/** One browser's push subscription, as it hands it over, and the words it is shown by. */
export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The browser and its system in words, such as 「iPhone の Safari」. */
  label: string;
}

/** Which browser to stop notifying: the push address it subscribed with. */
export interface PushDeviceRemoval {
  endpoint: string;
}

/** Whether the Worker now notifies the browser. */
export interface PushDeviceState {
  subscribed: boolean;
}

/**
 * A file an Operator Chat answer wrote or handed on, as it is kept beside the
 * answer's words; `drive` is where it was saved in Drive, which no answer
 * records yet, so it is null.
 */
export interface ChatGeneratedFile {
  id: string;
  filename: string;
  /** Read from its extension; a file of a kind OrangeAgent does not name is `application/octet-stream`. */
  mediaType: string;
  size: number;
  drive: { url: string } | null;
}

/** Where a recording is: being transcribed, transcribed, or failed with the reason. */
export type TranscriptState = 'transcribing' | 'completed' | 'failed';

/** Where a transcript's minutes are: being written, written, or failed with the reason. */
export type MinutesState = 'writing' | 'completed' | 'failed';

/** One recording uploaded on 文字起こし, as the list shows it. */
export interface TranscriptSummary {
  id: string;
  /** The recording's file name, which names the transcript until it is renamed. */
  title: string;
  filename: string;
  mediaType: string;
  size: number;
  state: TranscriptState;
  /** Why the transcription failed, or that it stopped and can be started again. */
  error: string | null;
  /** How long the recording is, once it is transcribed and the model said. */
  durationSeconds: number | null;
  /** The OpenRouter model it was transcribed with. */
  model: string;
  /** How many voices the model told apart; null when it told none apart. */
  speakers: number | null;
  minutesState: MinutesState | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One speaker's turn: how far into the recording, who by voice (話者1, 話者2…), and what they said. */
export interface TranscriptLine {
  at: number | null;
  speaker: string | null;
  text: string;
}

/** One recording with its transcript and minutes. */
export interface TranscriptDetail extends TranscriptSummary {
  lines: TranscriptLine[];
  /** The minutes as Markdown, once written. */
  minutes: string | null;
  minutesError: string | null;
  /** The AI Connection's model that wrote the minutes. */
  minutesModel: string | null;
  /** What the person asked the minutes to be written with, beside the transcript. */
  minutesInstructions: string;
}

/** The 文字起こし screen: every recording, newest first, and what can be done with them now. */
export interface TranscriptList {
  transcripts: TranscriptSummary[];
  /** Whether a Transcription Connection is saved, without which nothing is transcribed. */
  transcription: boolean;
  /** Whether an AI Connection is saved, without which no minutes are written. */
  minutes: boolean;
}

/** What 議事録にする sends: how the minutes should be written, beyond the usual. */
export interface MinutesInput {
  instructions?: string;
}

export interface ContactPageEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  registrationDeadline: string | null;
  status: AttendanceStatus;
  comment: string;
  open: boolean;
}


/** The one page a Contact has: its attendance and its comments. */
export interface ContactPage {
  account: { accountId: string; name: string };
  contact: { contactId: string; name: string };
  events: ContactPageEvent[];
}

/** Who wrote a memory: Operator Chat's AI, the AI of a member's own CLI, or a member on the 記憶 screen. */
export type MemoryAuthorKind = 'chat' | 'cli' | 'person';

/**
 * Whether a memory is found: only an `active` one is. A `candidate` waits on
 * 記憶 for a member, a `superseded` one was replaced by a newer fact, a
 * `rejected` one failed its checks, and a `forgotten` one was put away.
 */
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'rejected' | 'forgotten';

/** What a memory is about. */
export type MemoryKind = 'fact' | 'preference' | 'event' | 'instruction' | 'task' | 'derived';

/**
 * How far a memory can be trusted, by who said what it rests on: a member,
 * an AI confirming it by acting, an AI proposing it, an inference, or
 * something read in outside material such as a mail.
 */
export type MemoryProvenance = 'member' | 'confirmed' | 'proposed' | 'inferred' | 'external';

/** Where the words a memory rests on came from: Operator Chat, a member's CLI, a member on 記憶, or a memory kept before Episodes. */
export type MemoryEpisodeSource = 'chat' | 'cli' | 'person' | 'legacy';

/**
 * One thing the Account keeps in its Memory: its words, who wrote it, and
 * where. Every memory is on the 記憶 screen, where a member reads, corrects,
 * and deletes it, whoever wrote it.
 */
export interface Memory {
  id: string;
  content: string;
  author: {
    kind: MemoryAuthorKind;
    /** The member who wrote it, or whose CLI did, by name or Google account; empty for Operator Chat's AI. */
    name: string;
    /** The Operator Chat conversation it was kept in, when it was. */
    conversationId: string | null;
  };
  /** The member who last changed its words on the 記憶 screen, or null when nobody has. */
  editedBy: string | null;
  status: MemoryStatus;
  kind: MemoryKind;
  provenance: MemoryProvenance;
  createdAt: string;
  updatedAt: string;
}

/** The Account's Memory, the one changed last first. */
export interface MemoryList {
  memories: Memory[];
}

/** One memory a search found, and how it matched: by meaning (cosine similarity), by its words (the share of the query's keywords it holds), or both. */
export interface MemoryHit {
  memory: Memory;
  similarity: number | null;
  keywords: number | null;
}

/**
 * What a search of the Memory found, the same search an AI's memory.search
 * makes: at most 10, best first. No hits means the Memory holds nothing it is
 * certain of, and the AI is told so rather than given the nearest guess.
 */
export interface MemorySearch {
  query: string;
  hits: MemoryHit[];
}

/** One change to a memory, as its history shows it. */
export interface MemoryChange {
  at: string;
  /** Who made it: a member on 記憶, Operator Chat's AI, a member's CLI, or the Memory's own upkeep. */
  actor: { kind: 'pipeline' | 'member' | 'chat' | 'cli' | 'maintenance'; name: string };
  action: string;
}

/** Why the Account remembers something: the words it rests on, as they were said, and every change since. */
export interface MemoryDetail {
  memory: Memory;
  /** What it was kept from, or null when that was removed. */
  episode: {
    source: MemoryEpisodeSource;
    /** The member who said it, or whose CLI passed it, when known. */
    memberName: string;
    content: string;
    /** Where in `content`, in UTF-16 offsets, the words it rests on are. */
    evidence: { start: number; end: number } | null;
    conversationId: string | null;
    receivedAt: string;
  } | null;
  changes: MemoryChange[];
}
