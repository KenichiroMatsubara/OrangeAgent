import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A Skill: its name and when it applies, as its current revision's SKILL.md
 * states them, and which revision is current. The Skill itself is its folder,
 * kept in R2 file by file; this row is what names it, so a name is one
 * Skill's, and is in the same Time Travel restore as the Automations that
 * name it. `instructions` holds the words of a revision written before
 * Skills were folders, and is empty for every revision written since.
 */
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** Its name as the Agent Skills specification has it, and its directory's (ADR 0203). */
  name: text('name').notNull(),
  /** The name a person reads, as its SKILL.md's `metadata.display-name` states it. */
  title: text('title').notNull().default(''),
  /** When the Skill applies, which a run not started with it reads to decide whether to open it. */
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull(),
  revision: integer('revision').notNull().default(1),
  /** The directory its files are under, `skills/{account}/{directory}/`; null until a Skill kept before ADR 0203 is moved there. */
  directory: text('directory'),
  /** Whether an outside agent is offered it as an MCP prompt. */
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('skills_name_idx').on(table.name),
  check('skills_revision_check', sql`${table.revision} >= 1`),
  check('skills_published_check', sql`${table.published} in (0, 1)`),
]);

/** Every revision a Skill has had, so a run names the folder it read. */
export const skillRevisions = sqliteTable('skill_revisions', {
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  /** The words of a revision written before Skills were folders; empty since. */
  instructions: text('instructions').notNull(),
  /**
   * The R2 folder that holds this revision, every file of it as its own
   * object. Null for a revision written before Skills were folders, or by the
   * product's starting Skills, until the Worker first reads it and writes it
   * out as one.
   */
  folder: text('folder'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.skillId, table.revision] }),
]);

/**
 * The text files a Skill revision carried beside its instructions before
 * Skills were folders. Nothing writes here any more; a revision's rows are
 * written out into its folder the first time it is read.
 */
export const skillFiles = sqliteTable('skill_files', {
  skillId: text('skill_id').notNull(),
  revision: integer('revision').notNull(),
  path: text('path').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.skillId, table.revision, table.path] }),
  foreignKey({ columns: [table.skillId, table.revision], foreignColumns: [skillRevisions.skillId, skillRevisions.revision] }).onDelete('cascade'),
]);

export const EXECUTION_MODES = ['read_only', 'approval', 'unattended'] as const;
export const SUPPRESSION_WINDOWS = ['none', 'hour', 'day', 'week', 'forever'] as const;
export const AUTOMATION_TRIGGERS = ['mail', 'morning', 'schedule'] as const;

/**
 * An Automation: its Trigger Time, the Skills it starts with, and the tools it
 * may call. Every Automation the product runs has the `schedule` Trigger.
 * Rows a mail or the Morning started before migration 0042 are kept archived
 * for the Runs and Scheduled Events that name them, which is why the Trigger,
 * the Selection Policy, the priority, and the Contact List columns and their
 * checks remain; nothing writes them now. The `state` column the on-or-off
 * flag replaced (migration 0054) stays in the table for the same reason —
 * SQLite cannot drop a column a table check names — and is not declared here,
 * so nothing reads or writes it.
 */
export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  trigger: text('trigger', { enum: AUTOMATION_TRIGGERS }).notNull(),
  /** Whether it runs at its Trigger Time. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  executionMode: text('execution_mode', { enum: EXECUTION_MODES }).notNull().default('unattended'),
  contactListId: text('contact_list_id').references(() => contactLists.id, { onDelete: 'restrict' }),
  suppressionWindow: text('suppression_window', { enum: SUPPRESSION_WINDOWS }).notNull().default('none'),
  /** The Automation Revision its runs now record. */
  revision: integer('revision').notNull().default(1),
  /** Which mail it takes, as JSON; a mail Automation's alone. */
  selectionPolicy: text('selection_policy'),
  /** Its place among the mail Automations that take the same message, highest first; a mail Automation's alone. */
  priority: integer('priority'),
  /** Its Trigger Time; a timed Automation's alone. */
  schedule: text('schedule'),
  /** When its Trigger Time next starts it, while it is on. */
  nextRunAt: text('next_run_at'),
  /** The model its runs think with, one the AI Connection names; null for the Connection's default. */
  model: text('model'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('automations_trigger_check', sql`${table.trigger} in ('mail', 'morning', 'schedule')`),
  check('automations_enabled_check', sql`${table.enabled} in (0, 1)`),
  check('automations_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('automations_window_check', sql`${table.suppressionWindow} in ('none', 'hour', 'day', 'week', 'forever')`),
  check('automations_revision_check', sql`${table.revision} >= 1`),
  check('automations_mail_check', sql`(${table.trigger} = 'mail') = (${table.selectionPolicy} is not null and json_valid(${table.selectionPolicy}) and ${table.priority} is not null)`),
  check('automations_mail_only_check', sql`${table.trigger} = 'mail' or (${table.selectionPolicy} is null and ${table.priority} is null)`),
  check('automations_schedule_check', sql`(${table.trigger} = 'schedule') = (${table.schedule} is not null)`),
  check('automations_next_run_check', sql`${table.nextRunAt} is null or ${table.trigger} = 'schedule'`),
  check('automations_morning_check', sql`${table.trigger} != 'morning' or (${table.executionMode} != 'approval' and ${table.suppressionWindow} = 'none' and ${table.contactListId} is null)`),
  uniqueIndex('automations_name_idx').on(table.name),
  // The Morning starts one Automation; an Account has at most one.
  uniqueIndex('automations_morning_idx').on(table.trigger).where(sql`${table.trigger} = 'morning'`),
  index('automations_due_idx').on(table.enabled, table.nextRunAt),
]);

/** The Skills an Automation names, every run of it reading them in this order. */
export const automationSkills = sqliteTable('automation_skills', {
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'restrict' }),
  position: integer('position').notNull(),
}, (table) => [
  primaryKey({ columns: [table.automationId, table.position] }),
  uniqueIndex('automation_skills_skill_idx').on(table.automationId, table.skillId),
  index('automation_skills_named_idx').on(table.skillId),
]);

/** An Automation's Tool Grant: each tool its runs may call. */
export const automationTools = sqliteTable('automation_tools', {
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
}, (table) => [
  primaryKey({ columns: [table.automationId, table.tool] }),
]);

/**
 * An immutable Automation Revision: what its runs did with what they were
 * handed. A rename, turning it on or off, a priority, or a Trigger Time is not one.
 */
export const automationRevisions = sqliteTable('automation_revisions', {
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  /** The Skills it named, in order, as a JSON array of ids. */
  skillIds: text('skill_ids').notNull(),
  /** The tools it granted, as a JSON array of names. */
  tools: text('tools').notNull(),
  executionMode: text('execution_mode', { enum: EXECUTION_MODES }).notNull(),
  contactListId: text('contact_list_id'),
  suppressionWindow: text('suppression_window', { enum: SUPPRESSION_WINDOWS }).notNull(),
  selectionPolicy: text('selection_policy'),
  /** The model it named, or null for the AI Connection's default. */
  model: text('model'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.automationId, table.revision] }),
  check('automation_revisions_skills_check', sql`json_valid(${table.skillIds}) and json_type(${table.skillIds}) = 'array'`),
  check('automation_revisions_tools_check', sql`json_valid(${table.tools}) and json_type(${table.tools}) = 'array'`),
  check('automation_revisions_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('automation_revisions_window_check', sql`${table.suppressionWindow} in ('none', 'hour', 'day', 'week', 'forever')`),
]);

export const RUN_TRIGGERS = ['mail', 'morning', 'schedule', 'chat'] as const;
export const RUN_STATUSES = ['planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed'] as const;

/**
 * One Run: an Automation working on one Trigger, or one Operator Chat
 * exchange. It is planned, then held, retained, or applied by its Execution
 * Mode; it records what the model was and did, and where its Run Transcript
 * is kept while it lasts.
 */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),
  automationId: text('automation_id').references(() => automations.id, { onDelete: 'restrict' }),
  automationRevision: integer('automation_revision'),
  /** The Source Message a mail Automation's run was started for. */
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id, { onDelete: 'cascade' }),
  executionMode: text('execution_mode', { enum: EXECUTION_MODES }).notNull(),
  status: text('status', { enum: RUN_STATUSES }).notNull(),
  model: text('model'),
  /** Every Skill the run was started with and the revision it read, as a JSON array. */
  skills: text('skills').notNull().default('[]'),
  toolCalls: integer('tool_calls').notNull().default(0),
  tokens: integer('tokens').notNull().default(0),
  /** How long the run held its browser, in milliseconds: from acquiring a Browser Run session to closing it. */
  browserMs: integer('browser_ms').notNull().default(0),
  output: text('output'),
  error: text('error'),
  transcriptKey: text('transcript_key'),
  transcriptExpiresAt: text('transcript_expires_at'),
  startedAt: text('started_at').notNull(),
  plannedAt: text('planned_at'),
  /** When the approval it waits for expires. */
  expiresAt: text('expires_at'),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('runs_trigger_check', sql`${table.trigger} in ('mail', 'morning', 'schedule', 'chat')`),
  check('runs_status_check', sql`${table.status} in ('planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed')`),
  check('runs_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('runs_browser_ms_check', sql`${table.browserMs} >= 0`),
  check('runs_automation_check', sql`(${table.trigger} = 'chat') = (${table.automationId} is null) and (${table.automationId} is null) = (${table.automationRevision} is null)`),
  check('runs_source_check', sql`(${table.trigger} = 'mail') = (${table.sourceMessageId} is not null)`),
  check('runs_skills_check', sql`json_valid(${table.skills}) and json_type(${table.skills}) = 'array'`),
  // A mail Automation reads one Source Message once.
  uniqueIndex('runs_mail_idx').on(table.automationId, table.sourceMessageId).where(sql`${table.sourceMessageId} is not null`),
  index('runs_status_idx').on(table.status, table.updatedAt),
  index('runs_automation_idx').on(table.automationId, table.startedAt),
  index('runs_started_idx').on(table.startedAt),
]);

export const PLANNED_WRITE_STATUSES = ['planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired'] as const;

/**
 * One write a Run planned, frozen as the call it made to a tool of the
 * product's one list, and applied later by the handler that performs the same
 * call.
 */
export const plannedWrites = sqliteTable('planned_writes', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  tool: text('tool').notNull(),
  arguments: text('arguments').notNull(),
  dependsOn: text('depends_on').notNull().default('[]'),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status', { enum: PLANNED_WRITE_STATUSES }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  result: text('result'),
  error: text('error'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('planned_writes_status_check', sql`${table.status} in ('planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired')`),
  check('planned_writes_attempts_check', sql`${table.attempts} >= 0`),
  check('planned_writes_arguments_check', sql`json_valid(${table.arguments})`),
  uniqueIndex('planned_writes_run_key_idx').on(table.runId, table.key),
  uniqueIndex('planned_writes_idempotency_idx').on(table.idempotencyKey),
  index('planned_writes_run_idx').on(table.runId, table.createdAt),
  index('planned_writes_retry_idx').on(table.status, table.nextAttemptAt),
]);

export const sourceMessages = sqliteTable('source_messages', {
  id: text('id').primaryKey(),
  gmailMessageId: text('gmail_message_id').notNull().unique(),
  gmailHistoryId: text('gmail_history_id').notNull(),
  sender: text('sender').notNull(),
  subject: text('subject').notNull(),
  receivedAt: text('received_at').notNull(),
  processedAt: text('processed_at'),
  driveFolderId: text('drive_folder_id'),
  state: text('state', { enum: ['pending', 'processing', 'processed', 'skipped', 'exception'] }).notNull().default('pending'),
}, (table) => [
  check('source_messages_state_check', sql`${table.state} in ('pending', 'processing', 'processed', 'skipped', 'exception')`),
]);

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  /** Its Owning Automation: the Automation whose run created it, or null when Operator Chat did. */
  automationId: text('automation_id').references(() => automations.id, { onDelete: 'restrict' }),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  googleEventId: text('google_event_id'),
  title: text('title').notNull(),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  location: text('location').notNull().default(''),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['draft', 'scheduled', 'cancelled', 'exception'] }).notNull(),
  attendanceDeadline: text('attendance_deadline'),
  /** The Calendar Revision last observed for this event, held as an optimistic lock on the next merge. */
  calendarEtag: text('calendar_etag'),
  /**
   * The rendered description OrangeAgent last wrote to Google Calendar. It
   * differs from `description`, which holds the extracted Event Summary; the
   * difference between this and the live Calendar value is what identifies a
   * Manual Override.
   */
  calendarDescription: text('calendar_description').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('events_status_check', sql`${table.status} in ('draft', 'scheduled', 'cancelled', 'exception')`),
  index('events_start_idx').on(table.startsAt),
  index('events_automation_idx').on(table.automationId),
]);

export const eventOverrides = sqliteTable('event_overrides', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  actorIdentityId: text('actor_identity_id').notNull(),
  changesJson: text('changes_json').notNull(),
  reason: text('reason').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('event_overrides_event_idx').on(table.eventId, table.createdAt),
]);

/**
 * One declared attendance by somebody who is not a Contact. Keyed by the Event
 * Response that declared it so reprocessing and correction replace a party's
 * rows rather than accumulate beside them.
 */
export const guestRegistrations = sqliteTable('guest_registrations', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  name: text('name').notNull(),
  affiliation: text('affiliation').notNull().default(''),
  attending: integer('attending', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('guest_registrations_event_idx').on(table.eventId),
  index('guest_registrations_source_idx').on(table.eventId, table.sourceMessageId),
]);

export const attendance = sqliteTable('attendance', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['unanswered', 'attending', 'not_attending'] }).notNull().default('unanswered'),
  comment: text('comment').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.contactId] }),
  check('attendance_status_check', sql`${table.status} in ('unanswered', 'attending', 'not_attending')`),
]);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  state: text('state', { enum: ['pending', 'running', 'succeeded', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: text('available_at').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('jobs_state_check', sql`${table.state} in ('pending', 'running', 'succeeded', 'failed')`),
  index('jobs_due_idx').on(table.state, table.availableAt),
]);

export const exceptions = sqliteTable('exceptions', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  code: text('code').notNull(),
  message: text('message').notNull(),
  state: text('state', { enum: ['open', 'resolved', 'retry_requested'] }).notNull().default('open'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
}, (table) => [
  check('exceptions_state_check', sql`${table.state} in ('open', 'resolved', 'retry_requested')`),
  index('exceptions_state_idx').on(table.state),
]);

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['line', 'ai', 'discord'] }).notNull(),
  label: text('label').notNull(),
  credential: text('credential').notNull(),
  status: text('status', { enum: ['active', 'disconnected'] }).notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('connections_kind_check', sql`${table.kind} in ('line', 'ai', 'discord')`),
  check('connections_status_check', sql`${table.status} in ('active', 'disconnected')`),
]);

export const googleConnections = sqliteTable('google_connections', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['automation_inbox'] }).notNull(),
  googleSubject: text('google_subject').notNull().unique(),
  inboxAddress: text('inbox_address').notNull().unique(),
  grantedScopes: text('granted_scopes').notNull(),
  tokenEnvelope: text('token_envelope').notNull(),
  gmailHistoryId: text('gmail_history_id').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  status: text('status', { enum: ['active', 'reauthentication_required', 'disconnected'] }).notNull(),
  lastSyncedAt: text('last_synced_at'),
  lastError: text('last_error'),
  /** Start of the current uninterrupted automation failure, cleared by the next successful run. */
  failingSince: text('failing_since'),
  /** Last moment the Administrators were told that automation stopped working. */
  alertedAt: text('alerted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('google_connections_kind_check', sql`${table.kind} = 'automation_inbox'`),
  check('google_connections_enabled_check', sql`${table.enabled} in (0, 1)`),
  check('google_connections_status_check', sql`${table.status} in ('active', 'reauthentication_required', 'disconnected')`),
]);

export const deliveries = sqliteTable('deliveries', {
  id: text('id').primaryKey(),
  eventId: text('event_id').references(() => events.id),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  outcome: text('outcome').notNull(),
  externalId: text('external_id'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('deliveries_source_message_idx').on(table.sourceMessageId, table.createdAt),
]);

export const automationWarnings = sqliteTable('automation_warnings', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  code: text('code').notNull(),
  message: text('message').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('automation_warnings_source_idx').on(table.sourceMessageId, table.createdAt),
]);

/**
 * The Tasks an Account kept in OrangeAgent before they moved to Google Tasks
 * (ADR 0198). Nothing writes a Task here any more; a row is read once, to be
 * copied into Google Tasks, and the table goes when every Account's are.
 */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  /** The Google Tasks task this row was copied into; null until it is. */
  googleTaskId: text('google_task_id'),
  accountId: text('organization_id').notNull(),
  /** Null for a Task an Account added by hand: nothing it read asked for it. */
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  sourceMessageSubject: text('source_message_subject').notNull(),
  /** The Planned Write that created this Task, so the write is applied once. */
  plannedWriteId: text('planned_write_id'),
  /** The secret in this Task's own link; null until the Task is first given one. */
  linkToken: text('link_token'),
  scheduledEventId: text('scheduled_event_id').references(() => events.id),
  scheduledEventTitle: text('scheduled_event_title'),
  title: text('title').notNull(),
  /** An Asia/Tokyo date as YYYY-MM-DD, or null for a Task with no deadline. */
  deadline: text('deadline'),
  assigneeContactId: text('assignee_member_id').references(() => contacts.id),
  assigneeName: text('assignee_name').notNull().default('未割り当て'),
  description: text('description').notNull(),
  remarks: text('remarks').notNull().default(''),
  status: text('status', { enum: ['open', 'completed', 'cancelled'] }).notNull().default('open'),
  /** Kept in step with status until the column is dropped. */
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  completedAt: text('completed_at'),
  /** Who completed the Task: the Account, an Automation, its assignee's Contact Page, or whoever held its link. */
  completedVia: text('completed_via', { enum: ['account', 'agent', 'contact_page', 'task_link'] }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('tasks_completed_via_check', sql`${table.completedVia} IS NULL OR ${table.completedVia} in ('account', 'agent', 'contact_page', 'task_link')`),
  check('tasks_status_check', sql`${table.status} in ('open', 'completed', 'cancelled')`),
  check('tasks_completed_check', sql`${table.completed} in (0, 1)`),
  uniqueIndex('tasks_planned_write_idx').on(table.plannedWriteId),
  uniqueIndex('tasks_link_token_idx').on(table.linkToken),
  index('tasks_order_idx').on(table.status, table.deadline),
  index('tasks_assignee_idx').on(table.assigneeContactId),
  index('tasks_scheduled_event_idx').on(table.scheduledEventId),
  index('tasks_updated_idx').on(table.updatedAt),
]);

export const deliveryArchives = sqliteTable('delivery_archives', {
  id: text('id').primaryKey(),
  objectKey: text('object_key').notNull(),
  recordCount: integer('record_count').notNull(),
  archivedBefore: text('archived_before').notNull(),
  createdAt: text('created_at').notNull(),
});

export const contacts = sqliteTable('members', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  state: text('state', { enum: ['active', 'inactive'] }).notNull().default('active'),
  /** What kind of Contact this is, in the Account's own words. */
  description: text('description').notNull().default(''),
  tags: text('tags').notNull().default('[]'),
  googleSubject: text('google_subject'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('members_state_check', sql`${table.state} in ('active', 'inactive')`),
  uniqueIndex('members_email_unique').on(table.email).where(sql`${table.email} <> ''`),
  uniqueIndex('members_google_subject_unique').on(table.googleSubject).where(sql`${table.googleSubject} is not null`),
]);

export const eventRecipients = sqliteTable('event_recipients', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('member_id').notNull().references(() => contacts.id),
  nameSnapshot: text('name_snapshot').notNull(),
  emailSnapshot: text('email_snapshot').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.contactId] }),
]);

export const lineDestinations = sqliteTable('line_destinations', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  destinationId: text('destination_id').notNull(),
  displayName: text('display_name').notNull().default(''),
  kind: text('kind', { enum: ['user', 'group', 'room'] }).notNull(),
  status: text('status', { enum: ['discovered', 'disabled'] }).notNull().default('discovered'),
  source: text('source', { enum: ['webhook', 'manual'] }).notNull().default('webhook'),
  discoveredAt: text('discovered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('line_destinations_kind_check', sql`${table.kind} in ('user', 'group', 'room')`),
  check('line_destinations_status_check', sql`${table.status} in ('discovered', 'disabled')`),
  uniqueIndex('line_destinations_connection_destination_idx').on(table.connectionId, table.destinationId),
]);

export const contactLinkTokens = sqliteTable('member_link_tokens', {
  token: text('token').primaryKey(),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

/** The single-use link that first brings a Contact into the Contact Portal. */
export const portalInvitations = sqliteTable('portal_invitations', {
  token: text('token').primaryKey(),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('portal_invitations_member_idx').on(table.contactId, table.usedAt),
]);

export const contactLineDestinations = sqliteTable('member_line_destinations', {
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  lineDestinationId: text('line_destination_id').notNull().references(() => lineDestinations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.contactId, table.lineDestinationId] }),
  uniqueIndex('member_line_destinations_destination_unique').on(table.lineDestinationId),
]);

export const eventAttachments = sqliteTable('event_attachments', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  gmailAttachmentId: text('gmail_attachment_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  driveFileId: text('drive_file_id'),
  publicUrl: text('public_url'),
  outcome: text('outcome', { enum: ['succeeded', 'failed'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('event_attachments_outcome_check', sql`${table.outcome} in ('succeeded', 'failed')`),
  uniqueIndex('event_attachments_event_gmail_idx').on(table.eventId, table.gmailAttachmentId),
  index('event_attachments_event_idx').on(table.eventId, table.createdAt),
]);

export type GoogleConnectionRecord = typeof googleConnections.$inferSelect;

/**
 * Remote MCP Servers this Account has connected, with a static bearer token or
 * an OAuth grant under the Account's envelope encryption, and why signing in
 * to one last failed or why its grant stopped working.
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  tokenEnvelope: text('token_envelope'),
  oauthEnvelope: text('oauth_envelope'),
  oauthError: text('oauth_error'),
  revision: text('revision', { enum: ['2026-07-28', '2025-06-18'] }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('mcp_servers_revision_check', sql`${table.revision} is null or ${table.revision} in ('2026-07-28', '2025-06-18')`),
  uniqueIndex('mcp_servers_name_idx').on(table.name),
]);

/**
 * A site the Account's browser is signed in to (ADR 0200): what the browser
 * held of a person's sign-in, its cookies and localStorage, under the
 * Account's envelope encryption, and, while a person is signing in, the
 * Browser Run session and tab they sign in through.
 */
export const browserLogins = sqliteTable('browser_logins', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  site: text('site').notNull(),
  url: text('url').notNull(),
  stateEnvelope: text('state_envelope'),
  sessionId: text('session_id'),
  targetId: text('target_id'),
  savedAt: text('saved_at'),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('browser_logins_site_idx').on(table.site),
]);

/** The browser an Access Token or an Operator Token keeps open between its MCP calls: its Browser Run session and page. */
export const keyBrowsers = sqliteTable('key_browsers', {
  keyId: text('key_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  targetId: text('target_id').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatConversations = sqliteTable('chat_conversations', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('chat_conversations_recent_idx').on(table.updatedAt),
]);

/** One exchange of Operator Chat, recorded against the Run that carried it. */
export const chatTurns = sqliteTable('chat_turns', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  /** The exchange this one was asked after, or null for a first message; its siblings are the branches beside it. */
  parentTurnId: text('parent_turn_id'),
  position: integer('position').notNull(),
  request: text('request').notNull(),
  response: text('response'),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  error: text('error'),
  /** The Identity of the member who asked, or null for an exchange asked before it was recorded. */
  askedByIdentity: text('asked_by_identity'),
  askedByName: text('asked_by_name').notNull().default(''),
  /** Every tool the answer called, in order, each failed one with why, as JSON. */
  tools: text('tools').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('chat_turns_status_check', sql`${table.status} in ('running', 'completed', 'failed')`),
  unique().on(table.conversationId, table.position),
  index('chat_turns_conversation_idx').on(table.conversationId, table.position),
]);

/**
 * A file the administrator attached to one Operator Chat exchange. Its bytes are
 * held in R2 under `objectKey`; the row says what the file is.
 */
export const chatAttachments = sqliteTable('chat_attachments', {
  id: text('id').primaryKey(),
  turnId: text('turn_id').notNull().references(() => chatTurns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull(),
  size: integer('size').notNull(),
  objectKey: text('object_key').notNull(),
  /** `request` for a file the administrator sent, `response` for one Claude wrote for the answer. */
  origin: text('origin', { enum: ['request', 'response'] }).notNull().default('request'),
  driveFileId: text('drive_file_id'),
  driveUrl: text('drive_url'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  unique().on(table.turnId, table.position),
  check('chat_attachments_origin_check', sql`${table.origin} IN ('request', 'response')`),
]);

/**
 * One conversation of Operator Chat (ADR 0201):
 * a log of events numbered per conversation, and the conversation as it stood
 * when an answer last ended, so opening it replays only what came after.
 */
export const chatThreads = sqliteTable('chat_threads', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  title: text('title').notNull(),
  /** The sequence of the conversation's latest event kept here. */
  lastSequence: integer('last_sequence').notNull().default(0),
  /** The snapshot's projection, as its JSON encoding, at `projectionSequence`; null until an answer first ends. */
  projection: text('projection'),
  projectionSequence: integer('projection_sequence').notNull().default(0),
  /** The Identity of the member who started it. */
  createdByIdentity: text('created_by_identity'),
  createdByName: text('created_by_name').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('chat_threads_recent_idx').on(table.updatedAt),
]);

/** One event of a conversation, as the JSON encoding of t3code's domain event. */
export const chatEvents = sqliteTable('chat_events', {
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.threadId, table.sequence] }),
]);

/** A file an answer of a conversation wrote or handed the member; R2 holds its bytes under `objectKey`. */
export const chatFiles = sqliteTable('chat_files', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  /** The Run of the answer that kept it. */
  runId: text('run_id').notNull(),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull(),
  size: integer('size').notNull(),
  objectKey: text('object_key').notNull(),
  createdAt: text('created_at').notNull(),
  /** Whether a member sent it with a message (`request`) or an answer wrote or handed it on (`response`). */
  origin: text('origin', { enum: ['response', 'request'] }).notNull().default('response'),
  /** Where it stands among the files of its message. */
  position: integer('position').notNull().default(0),
}, (table) => [
  index('chat_files_thread_idx').on(table.threadId, table.filename),
  index('chat_files_run_idx').on(table.runId, table.origin, table.position),
  check('chat_files_origin_check', sql`${table.origin} IN ('response', 'request')`),
]);

/**
 * A conversation's approval mode, and who last set it and when; a
 * conversation without one is in auto.
 */
export const chatThreadModes = sqliteTable('chat_thread_modes', {
  threadId: text('thread_id').primaryKey().references(() => chatThreads.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: ['read_only', 'ask', 'auto', 'unrestricted'] }).notNull(),
  /** The Identity of the member who last chose it; null when it was inherited as the conversation began. */
  changedByIdentity: text('changed_by_identity'),
  changedByName: text('changed_by_name').notNull().default(''),
  changedAt: text('changed_at').notNull(),
}, (table) => [
  index('chat_thread_modes_changed_idx').on(table.changedByIdentity, table.changedAt),
  check('chat_thread_modes_mode_check', sql`${table.mode} IN ('read_only', 'ask', 'auto', 'unrestricted')`),
]);

/**
 * An answer waiting for a person to approve one call, at most one per
 * conversation; R2 holds what the answer did until then under `stateKey`.
 */
export const chatPauses = sqliteTable('chat_pauses', {
  /** The runtime request the screen answers. */
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  callId: text('call_id').notNull(),
  tool: text('tool').notNull(),
  arguments: text('arguments').notNull(),
  /** The turn item that shows the call. */
  itemId: text('item_id').notNull(),
  stateKey: text('state_key').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('chat_pauses_thread_idx').on(table.threadId),
]);

/** A tool a person allowed always for the Account: no conversation asks about it again. */
export const chatToolAllowances = sqliteTable('chat_tool_allowances', {
  tool: text('tool').primaryKey(),
  allowedByIdentity: text('allowed_by_identity'),
  allowedByName: text('allowed_by_name').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

/**
 * One browser a member turned Operator Chat's notifications on in: where
 * its push service takes messages for it, and the keys they are encrypted for.
 */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  identityId: text('identity_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** The browser in words, as the person's own screen named it. */
  label: text('label').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpoint),
  index('push_subscriptions_identity_idx').on(table.identityId),
]);

/** A notification one answer of a conversation sent, at most one of each kind. */
export const chatNotices = sqliteTable('chat_notices', {
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  kind: text('kind', { enum: ['approval', 'question', 'completed', 'failed'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.threadId, table.runId, table.kind] }),
  check('chat_notices_kind_check', sql`${table.kind} IN ('approval', 'question', 'completed', 'failed')`),
]);

/** A named set of Contacts. Delivery resolves each Contact's handle from the Channel it sends on. */
export const contactLists = sqliteTable('contact_lists', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('contact_lists_name_idx').on(table.name),
]);

export const contactListMembers = sqliteTable('contact_list_members', {
  listId: text('list_id').notNull().references(() => contactLists.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.listId, table.contactId] }),
]);

/** The credential an outside agent presents, carrying one Tool Grant and one Contact List bound. */
export const accessTokens = sqliteTable('access_tokens', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('access_tokens_hash_idx').on(table.tokenHash),
]);

export const accessTokenTools = sqliteTable('access_token_tools', {
  tokenId: text('token_id').notNull().references(() => accessTokens.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tokenId, table.tool] }),
]);

/**
 * A member's own CLI or agent, acting on the Account as Operator Chat does. It
 * begins as a Login Code shown to a signed-in member and becomes the Token
 * when the code is exchanged once; only the hash of each is kept.
 */
export const operatorTokens = sqliteTable('operator_tokens', {
  id: text('id').primaryKey(),
  /** The Control Identity whose membership the Token acts under, checked on every call. */
  identityId: text('identity_id').notNull(),
  /** Null once the code is exchanged, so it is used at most once. */
  codeHash: text('code_hash'),
  codeExpiresAt: text('code_expires_at').notNull(),
  /** Null until the code is exchanged. */
  tokenHash: text('token_hash'),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  /** The OAuth client the member approved, or null for a Token a Login Code was exchanged for. */
  clientId: text('client_id'),
  /** The name the client registered under, as the 接続 screen shows it. */
  clientName: text('client_name'),
  /** Where the authorization code was sent, which its exchange must name again. */
  redirectUri: text('redirect_uri'),
  /** The S256 PKCE challenge the authorization code is exchanged against. */
  codeChallenge: text('code_challenge'),
  /** When the client's current access token stops working; it refreshes it until `expiresAt`. */
  accessExpiresAt: text('access_expires_at'),
  /** The hash of the one refresh token that may replace the access token, rotated on every use. */
  refreshHash: text('refresh_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('operator_tokens_code_idx').on(table.codeHash),
  uniqueIndex('operator_tokens_token_idx').on(table.tokenHash),
  uniqueIndex('operator_tokens_refresh_idx').on(table.refreshHash),
]);

/** One call a Token made while its calls were counted. No longer written. */
export const accessTokenCalls = sqliteTable('access_token_calls', {
  id: text('id').primaryKey(),
  tokenId: text('token_id').notNull().references(() => accessTokens.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  isWrite: integer('is_write', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('access_token_calls_write_check', sql`${table.isWrite} in (0, 1)`),
  index('access_token_calls_window_idx').on(table.tokenId, table.createdAt),
]);

/** One effect already performed, holding its repeat until the declared window passes. */
export const suppressions = sqliteTable('suppressions', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  tool: text('tool').notNull(),
  recordedAt: text('recorded_at').notNull(),
  expiresAt: text('expires_at'),
}, (table) => [
  index('suppressions_expiry_idx').on(table.expiresAt),
]);

/**
 * Where a Contact is reachable on a Channel. Discord lives here now;
 * LINE still lives in its own table until the migration that dissolves it, so
 * each Channel has exactly one source of truth rather than two.
 */
export const channelHandles = sqliteTable('channel_handles', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['discord'] }).notNull(),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  replyTarget: text('reply_target'),
  kind: text('kind', { enum: ['single', 'shared'] }).notNull().default('single'),
  displayName: text('display_name').notNull().default(''),
  source: text('source', { enum: ['inbound', 'manual'] }).notNull().default('inbound'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('channel_handles_channel_check', sql`${table.channel} in ('discord')`),
  check('channel_handles_kind_check', sql`${table.kind} in ('single', 'shared')`),
  check('channel_handles_source_check', sql`${table.source} in ('inbound', 'manual')`),
  check('channel_handles_primary_check', sql`${table.isPrimary} in (0, 1)`),
  uniqueIndex('channel_handles_identity_idx').on(table.channel, table.connectionId, table.externalId),
  index('channel_handles_contact_idx').on(table.contactId, table.channel),
]);

/**
 * One memory of the Account's Memory. This row is the record a member reads
 * and edits on 記憶; the meaning a search finds it by is kept in Vectorize,
 * under its id, in the Account's namespace.
 */
/**
 * What a memory was kept from, as it was said: the words a member typed on
 * 記憶, the text a run passed to `memory.add`, an Operator Chat exchange, or
 * for a memory kept before Episodes, that memory's own words. Never changed
 * once kept (ADR 0197).
 */
export const memoryEpisodes = sqliteTable('memory_episodes', {
  id: text('id').primaryKey(),
  source: text('source', { enum: ['chat', 'cli', 'person', 'legacy'] }).notNull(),
  memberIdentity: text('member_identity'),
  memberName: text('member_name').notNull().default(''),
  conversationId: text('conversation_id').references(() => chatConversations.id, { onDelete: 'set null' }),
  turnId: text('turn_id').references(() => chatTurns.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  state: text('state', { enum: ['received', 'extracting', 'committed', 'skipped', 'failed'] }).notNull(),
  extractorVersion: text('extractor_version'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  receivedAt: text('received_at').notNull(),
  processedAt: text('processed_at'),
}, (table) => [
  uniqueIndex('memory_episodes_hash_idx').on(table.contentHash),
  index('memory_episodes_state_idx').on(table.state, table.receivedAt),
  check('memory_episodes_source_check', sql`${table.source} in ('chat', 'cli', 'person', 'legacy')`),
  check('memory_episodes_state_check', sql`${table.state} in ('received', 'extracting', 'committed', 'skipped', 'failed')`),
]);

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  /** Who wrote it: Operator Chat's AI, the AI of a member's own CLI, or a member on 記憶. */
  authorKind: text('author_kind', { enum: ['chat', 'cli', 'person'] }).notNull(),
  /** The member who wrote it, or whose CLI did; empty for Operator Chat's AI. */
  authorName: text('author_name').notNull().default(''),
  conversationId: text('conversation_id').references(() => chatConversations.id, { onDelete: 'set null' }),
  turnId: text('turn_id').references(() => chatTurns.id, { onDelete: 'set null' }),
  /** The member who last changed its words on 記憶, or null when nobody has. */
  editedBy: text('edited_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  episodeId: text('episode_id').references(() => memoryEpisodes.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: ['fact', 'preference', 'event', 'instruction', 'task', 'derived'] }).notNull().default('fact'),
  /** Who said what the memory rests on: a member, an AI, or a tool's output. */
  speaker: text('speaker', { enum: ['user', 'agent', 'tool'] }).notNull().default('agent'),
  /** 1 a member said it, 2 an AI confirmed it by acting, 3 an AI proposed it, 4 inferred, 5 read in outside material. */
  provenance: integer('provenance').notNull().default(3),
  status: text('status', { enum: ['candidate', 'active', 'superseded', 'rejected', 'forgotten'] }).notNull().default('active'),
  /** Where in its Episode, in UTF-16 offsets, the words it rests on are. */
  evidenceStart: integer('evidence_start'),
  evidenceEnd: integer('evidence_end'),
  validFrom: text('valid_from').notNull().default(''),
  validTo: text('valid_to'),
  /** When its meaning was last put into Vectorize, or null until it is. */
  indexedAt: text('indexed_at'),
}, (table) => [
  index('memories_updated_idx').on(table.updatedAt),
  index('memories_status_idx').on(table.status, table.validTo),
  index('memories_unindexed_idx').on(table.indexedAt).where(sql`${table.indexedAt} IS NULL`),
  index('memories_episode_idx').on(table.episodeId),
  check('memories_author_kind_check', sql`${table.authorKind} in ('chat', 'cli', 'person')`),
]);

/** One keyword of a memory's words (a character bigram, a single character, or a run of letters and digits), and how often it occurs. */
export const memoryTerms = sqliteTable('memory_terms', {
  term: text('term').notNull(),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  count: integer('count').notNull(),
}, (table) => [
  primaryKey({ columns: [table.term, table.memoryId] }),
  index('memory_terms_memory_idx').on(table.memoryId),
]);

/** Every change to a memory, kept after the memory itself is erased; the id is not a foreign key for that reason. */
export const memoryChanges = sqliteTable('memory_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(),
  actorKind: text('actor_kind', { enum: ['pipeline', 'member', 'chat', 'cli', 'maintenance'] }).notNull(),
  actorName: text('actor_name').notNull().default(''),
  action: text('action').notNull(),
  memoryId: text('memory_id'),
  detail: text('detail'),
}, (table) => [
  index('memory_changes_memory_idx').on(table.memoryId, table.at),
]);

/** Which memories an Operator Chat answer kept or recalled, so its transcript links to them. */
export const memoryUses = sqliteTable('memory_uses', {
  turnId: text('turn_id').notNull().references(() => chatTurns.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').notNull().references(() => memories.id, { onDelete: 'cascade' }),
  use: text('use', { enum: ['saved', 'recalled'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.turnId, table.memoryId, table.use] }),
  check('memory_uses_use_check', sql`${table.use} in ('saved', 'recalled')`),
]);

/**
 * A recording uploaded on 文字起こし, its transcript, and the minutes written
 * from it. The recording's bytes are held in R2 under `objectKey`; `lines` is
 * the transcript as JSON, one line per speaker's turn.
 */
export const transcripts = sqliteTable('transcripts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull(),
  size: integer('size').notNull(),
  objectKey: text('object_key').notNull(),
  state: text('state', { enum: ['transcribing', 'completed', 'failed'] }).notNull().default('transcribing'),
  error: text('error'),
  /** The OpenRouter model it was transcribed with. */
  model: text('model').notNull(),
  durationSeconds: real('duration_seconds'),
  /** How many voices the model told apart; null when it told none apart. */
  speakers: integer('speakers'),
  lines: text('lines').notNull().default('[]'),
  minutesState: text('minutes_state', { enum: ['writing', 'completed', 'failed'] }),
  minutes: text('minutes'),
  minutesError: text('minutes_error'),
  minutesModel: text('minutes_model'),
  minutesInstructions: text('minutes_instructions').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('transcripts_state_check', sql`${table.state} in ('transcribing', 'completed', 'failed')`),
  check('transcripts_minutes_state_check', sql`${table.minutesState} IS NULL OR ${table.minutesState} in ('writing', 'completed', 'failed')`),
  index('transcripts_created_idx').on(table.createdAt),
]);
