-- One Automation, in one set of tables, whatever starts it.
--
-- A mail arriving, the Morning, and a Trigger Time are three Triggers of the
-- one Automation. Each is a row of `automations`, the Skills it starts with are
-- `automation_skills` in order, its Tool Grant is `automation_tools`, and every
-- change to what it does is an `automation_revisions` row. Every run of every
-- Automation, and every Operator Chat exchange, is one row of `runs`, and every
-- write a run plans is one row of `planned_writes`. The Agent Rule, the Schema
-- Rule, Typed Lists, and Prompts are gone, with every table that held them.
--
-- The Account chose to start these over rather than carry them: no
-- Automation, Skill, or run before this release is kept. Each Account gets its
-- starting mail Automation, Morning Automation, and their Skills again at its
-- next intake, because the markers that said it had them are removed here.
-- What the Account itself holds stays: Contacts, Contact Lists, Scheduled
-- Events, Tasks, Morning Entries, and its Operator Chat conversations, whose
-- exchanges are carried into `runs`. A Scheduled Event keeps no Owning
-- Automation, because the one that made it is gone.
--
-- Dropping a table deletes its rows first, and that delete cascades to the
-- tables that reference it, so the rows of every child that must survive are
-- carried aside and put back once its parent is rebuilt under the same ids.
-- Foreign keys are checked only when the migration commits.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `carry_attendance` AS SELECT * FROM `attendance`;
--> statement-breakpoint
CREATE TABLE `carry_event_attachments` AS SELECT * FROM `event_attachments`;
--> statement-breakpoint
CREATE TABLE `carry_event_overrides` AS SELECT * FROM `event_overrides`;
--> statement-breakpoint
CREATE TABLE `carry_event_recipients` AS SELECT * FROM `event_recipients`;
--> statement-breakpoint
CREATE TABLE `carry_guest_registrations` AS SELECT * FROM `guest_registrations`;
--> statement-breakpoint
CREATE TABLE `carry_chat_turns` AS SELECT * FROM `chat_turns`;
--> statement-breakpoint
CREATE TABLE `carry_chat_attachments` AS SELECT * FROM `chat_attachments`;
--> statement-breakpoint
CREATE TABLE `carry_morning_notices` AS SELECT * FROM `morning_notices`;
--> statement-breakpoint
CREATE TABLE `carry_chat_runs` AS SELECT * FROM `rule_runs` WHERE `intent` = 'chat';
--> statement-breakpoint
DROP TABLE `chat_attachments`;
--> statement-breakpoint
DROP TABLE `chat_turns`;
--> statement-breakpoint
DROP TABLE `morning_notices`;
--> statement-breakpoint
DROP TABLE `automation_runs`;
--> statement-breakpoint
DROP TABLE `automation_tools`;
--> statement-breakpoint
DROP TABLE `automations`;
--> statement-breakpoint
DROP TABLE `rule_effects`;
--> statement-breakpoint
DROP TABLE `rule_runs`;
--> statement-breakpoint
DROP TABLE `agent_runs`;
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `skills_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `skills_published_check` CHECK (`published` in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_idx` ON `skills` (`name`);
--> statement-breakpoint
CREATE TABLE `skill_revisions` (
	`skill_id` text NOT NULL,
	`revision` integer NOT NULL,
	`instructions` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`skill_id`, `revision`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`execution_mode` text DEFAULT 'unattended' NOT NULL,
	`contact_list_id` text,
	`suppression_window` text DEFAULT 'none' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`selection_policy` text,
	`priority` integer,
	`schedule` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_list_id`) REFERENCES `contact_lists`(`id`) ON DELETE restrict,
	CONSTRAINT `automations_trigger_check` CHECK (`trigger` in ('mail', 'morning', 'schedule')),
	CONSTRAINT `automations_state_check` CHECK (`state` in ('draft', 'active', 'suspended', 'archived')),
	CONSTRAINT `automations_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `automations_window_check` CHECK (`suppression_window` in ('none', 'hour', 'day', 'week', 'forever')),
	CONSTRAINT `automations_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `automations_mail_check` CHECK ((`trigger` = 'mail') = (`selection_policy` IS NOT NULL AND json_valid(`selection_policy`) AND `priority` IS NOT NULL)),
	CONSTRAINT `automations_mail_only_check` CHECK (`trigger` = 'mail' OR (`selection_policy` IS NULL AND `priority` IS NULL)),
	CONSTRAINT `automations_schedule_check` CHECK ((`trigger` = 'schedule') = (`schedule` IS NOT NULL)),
	CONSTRAINT `automations_next_run_check` CHECK (`next_run_at` IS NULL OR `trigger` = 'schedule'),
	CONSTRAINT `automations_morning_check` CHECK (`trigger` != 'morning' OR (`execution_mode` != 'approval' AND `suppression_window` = 'none' AND `contact_list_id` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_name_idx` ON `automations` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_morning_idx` ON `automations` (`trigger`) WHERE `trigger` = 'morning';
--> statement-breakpoint
CREATE INDEX `automations_due_idx` ON `automations` (`state`, `next_run_at`);
--> statement-breakpoint
CREATE TABLE `automation_skills` (
	`automation_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY (`automation_id`, `position`),
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_skills_skill_idx` ON `automation_skills` (`automation_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `automation_skills_named_idx` ON `automation_skills` (`skill_id`);
--> statement-breakpoint
CREATE TABLE `automation_tools` (
	`automation_id` text NOT NULL,
	`tool` text NOT NULL,
	PRIMARY KEY (`automation_id`, `tool`),
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `automation_revisions` (
	`automation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`skill_ids` text NOT NULL,
	`tools` text NOT NULL,
	`execution_mode` text NOT NULL,
	`contact_list_id` text,
	`suppression_window` text NOT NULL,
	`selection_policy` text,
	`created_at` text NOT NULL,
	PRIMARY KEY (`automation_id`, `revision`),
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade,
	CONSTRAINT `automation_revisions_skills_check` CHECK (json_valid(`skill_ids`) AND json_type(`skill_ids`) = 'array'),
	CONSTRAINT `automation_revisions_tools_check` CHECK (json_valid(`tools`) AND json_type(`tools`) = 'array'),
	CONSTRAINT `automation_revisions_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `automation_revisions_window_check` CHECK (`suppression_window` in ('none', 'hour', 'day', 'week', 'forever'))
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`automation_id` text,
	`automation_revision` integer,
	`source_message_id` text,
	`execution_mode` text NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`skills` text DEFAULT '[]' NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`output` text,
	`error` text,
	`transcript_key` text,
	`transcript_expires_at` text,
	`started_at` text NOT NULL,
	`planned_at` text,
	`expires_at` text,
	`decided_at` text,
	`decided_by` text,
	`finished_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE restrict,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON DELETE cascade,
	CONSTRAINT `runs_trigger_check` CHECK (`trigger` in ('mail', 'morning', 'schedule', 'chat')),
	CONSTRAINT `runs_status_check` CHECK (`status` in ('planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed')),
	CONSTRAINT `runs_mode_check` CHECK (`execution_mode` in ('read_only', 'approval', 'unattended')),
	CONSTRAINT `runs_automation_check` CHECK ((`trigger` = 'chat') = (`automation_id` IS NULL) AND (`automation_id` IS NULL) = (`automation_revision` IS NULL)),
	CONSTRAINT `runs_source_check` CHECK ((`trigger` = 'mail') = (`source_message_id` IS NOT NULL)),
	CONSTRAINT `runs_skills_check` CHECK (json_valid(`skills`) AND json_type(`skills`) = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_mail_idx` ON `runs` (`automation_id`, `source_message_id`) WHERE `source_message_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `runs_automation_idx` ON `runs` (`automation_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX `runs_started_idx` ON `runs` (`started_at`);
--> statement-breakpoint
CREATE TABLE `planned_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`key` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade,
	CONSTRAINT `planned_writes_status_check` CHECK (`status` in ('planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired')),
	CONSTRAINT `planned_writes_attempts_check` CHECK (`attempts` >= 0),
	CONSTRAINT `planned_writes_arguments_check` CHECK (json_valid(`arguments`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_writes_run_key_idx` ON `planned_writes` (`run_id`, `key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_writes_idempotency_idx` ON `planned_writes` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `planned_writes_run_idx` ON `planned_writes` (`run_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `planned_writes_retry_idx` ON `planned_writes` (`status`, `next_attempt_at`);
--> statement-breakpoint
-- Each Operator Chat exchange keeps the Run it was recorded as, under the same id.
INSERT OR IGNORE INTO `runs` (`id`, `trigger`, `execution_mode`, `status`, `started_at`, `finished_at`, `updated_at`)
SELECT
	`id`,
	'chat',
	CASE WHEN `execution_mode` in ('read_only', 'approval', 'unattended') THEN `execution_mode` ELSE 'unattended' END,
	CASE WHEN `status` in ('planning', 'completed', 'failed') THEN `status` ELSE 'completed' END,
	COALESCE(`created_at`, `updated_at`, ''),
	CASE WHEN `status` = 'planning' THEN NULL ELSE COALESCE(`updated_at`, `created_at`, '') END,
	COALESCE(`updated_at`, `created_at`, '')
FROM `carry_chat_runs`
WHERE `id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `chat_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`request` text NOT NULL,
	`response` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade,
	CONSTRAINT `chat_turns_status_check` CHECK (`status` in ('running', 'completed', 'failed')),
	UNIQUE (`conversation_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `chat_turns_conversation_idx` ON `chat_turns` (`conversation_id`, `position`);
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_turns` (`id`, `conversation_id`, `run_id`, `position`, `request`, `response`, `status`, `error`, `created_at`, `updated_at`)
SELECT
	`id`,
	`conversation_id`,
	`rule_run_id`,
	`position`,
	COALESCE(`request`, ''),
	`response`,
	CASE WHEN `status` in ('running', 'completed', 'failed') THEN `status` ELSE 'failed' END,
	`error`,
	COALESCE(`created_at`, `updated_at`, ''),
	COALESCE(`updated_at`, `created_at`, '')
FROM `carry_chat_turns`
WHERE `id` IS NOT NULL
	AND `position` IS NOT NULL
	AND EXISTS (SELECT 1 FROM `chat_conversations` WHERE `chat_conversations`.`id` = `carry_chat_turns`.`conversation_id`)
	AND EXISTS (SELECT 1 FROM `runs` WHERE `runs`.`id` = `carry_chat_turns`.`rule_run_id`);
--> statement-breakpoint
CREATE TABLE `chat_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`position` integer NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON DELETE cascade,
	UNIQUE (`turn_id`, `position`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_attachments` (`id`, `turn_id`, `position`, `filename`, `media_type`, `size`, `object_key`, `created_at`)
SELECT `id`, `turn_id`, `position`, COALESCE(`filename`, ''), COALESCE(`media_type`, ''), COALESCE(`size`, 0), COALESCE(`object_key`, ''), COALESCE(`created_at`, '')
FROM `carry_chat_attachments`
WHERE `id` IS NOT NULL
	AND `position` IS NOT NULL
	AND EXISTS (SELECT 1 FROM `chat_turns` WHERE `chat_turns`.`id` = `carry_chat_attachments`.`turn_id`);
--> statement-breakpoint
CREATE TABLE `morning_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`morning` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`texts` text NOT NULL,
	`composed_by` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null,
	CONSTRAINT `morning_notices_channel_check` CHECK (`channel` in ('email', 'line', 'discord')),
	CONSTRAINT `morning_notices_composed_by_check` CHECK (`composed_by` in ('automation', 'fixed'))
);
--> statement-breakpoint
CREATE INDEX `morning_notices_address_idx` ON `morning_notices` (`morning`, `channel`, `destination`);
--> statement-breakpoint
-- A Morning Notice keeps its texts, so a retry still sends them; the run that wrote it is gone.
INSERT OR IGNORE INTO `morning_notices` (`id`, `morning`, `channel`, `destination`, `texts`, `composed_by`, `run_id`, `created_at`)
SELECT `id`, COALESCE(`morning`, ''), `channel`, COALESCE(`destination`, ''), COALESCE(`texts`, '[]'), `composed_by`, NULL, COALESCE(`created_at`, '')
FROM `carry_morning_notices`
WHERE `id` IS NOT NULL
	AND `channel` in ('email', 'line', 'discord')
	AND `composed_by` in ('automation', 'fixed');
--> statement-breakpoint
-- An entry whose notice could not be kept waits to be composed again.
UPDATE `morning_entries` SET `notice_id` = NULL
WHERE `notice_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `morning_notices` WHERE `morning_notices`.`id` = `morning_entries`.`notice_id`);
--> statement-breakpoint
CREATE TABLE `events_next` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`automation_id` text,
	`source_message_id` text,
	`google_event_id` text,
	`title` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`attendance_deadline` text,
	`calendar_etag` text,
	`calendar_description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE restrict,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`),
	CONSTRAINT `events_status_check` CHECK (`status` in ('draft', 'scheduled', 'cancelled', 'exception'))
);
--> statement-breakpoint
INSERT INTO `events_next` (`id`, `organization_id`, `automation_id`, `source_message_id`, `google_event_id`, `title`, `starts_at`, `ends_at`, `location`, `description`, `status`, `attendance_deadline`, `calendar_etag`, `calendar_description`, `created_at`, `updated_at`)
SELECT
	`id`,
	COALESCE(`organization_id`, ''),
	NULL,
	CASE WHEN EXISTS (SELECT 1 FROM `source_messages` WHERE `source_messages`.`id` = `events`.`source_message_id`) THEN `source_message_id` END,
	`google_event_id`,
	COALESCE(`title`, ''),
	COALESCE(`starts_at`, ''),
	COALESCE(`ends_at`, `starts_at`, ''),
	COALESCE(`location`, ''),
	COALESCE(`description`, ''),
	CASE WHEN `status` in ('draft', 'scheduled', 'cancelled', 'exception') THEN `status` ELSE 'exception' END,
	`attendance_deadline`,
	`calendar_etag`,
	COALESCE(`calendar_description`, ''),
	COALESCE(`created_at`, `updated_at`, ''),
	COALESCE(`updated_at`, `created_at`, '')
FROM `events`
WHERE `id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `events_next` RENAME TO `events`;
--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`starts_at`);
--> statement-breakpoint
CREATE INDEX `events_automation_idx` ON `events` (`automation_id`);
--> statement-breakpoint
-- A carried row goes back only beside the rows it names, so the rebuild never
-- adds a reference that points nowhere.
INSERT OR IGNORE INTO `attendance` SELECT * FROM `carry_attendance`
WHERE EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `carry_attendance`.`event_id`)
	AND EXISTS (SELECT 1 FROM `members` WHERE `members`.`id` = `carry_attendance`.`member_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `event_attachments` SELECT * FROM `carry_event_attachments`
WHERE EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `carry_event_attachments`.`event_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `event_overrides` SELECT * FROM `carry_event_overrides`
WHERE EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `carry_event_overrides`.`event_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `event_recipients` SELECT * FROM `carry_event_recipients`
WHERE EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `carry_event_recipients`.`event_id`)
	AND EXISTS (SELECT 1 FROM `members` WHERE `members`.`id` = `carry_event_recipients`.`member_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `guest_registrations` SELECT * FROM `carry_guest_registrations`
WHERE EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `carry_guest_registrations`.`event_id`)
	AND EXISTS (SELECT 1 FROM `source_messages` WHERE `source_messages`.`id` = `carry_guest_registrations`.`source_message_id`);
--> statement-breakpoint
DROP TABLE `agent_rule_permitted_recipient_lists`;
--> statement-breakpoint
DROP TABLE `agent_rule_permitted_line_lists`;
--> statement-breakpoint
DROP TABLE `agent_rule_revisions`;
--> statement-breakpoint
DROP TABLE `agent_rules`;
--> statement-breakpoint
DROP TABLE `rule_permitted_recipient_lists`;
--> statement-breakpoint
DROP TABLE `rule_permitted_line_lists`;
--> statement-breakpoint
DROP TABLE `rule_revisions`;
--> statement-breakpoint
DROP TABLE `rules`;
--> statement-breakpoint
DROP TABLE `list_items`;
--> statement-breakpoint
DROP TABLE `lists`;
--> statement-breakpoint
DROP TABLE `prompt_revisions`;
--> statement-breakpoint
DROP TABLE `prompts`;
--> statement-breakpoint
-- A Task names the Planned Write that created it; none of the writes before this release is kept.
DROP INDEX `tasks_rule_effect_idx`;
--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `rule_effect_id` TO `planned_write_id`;
--> statement-breakpoint
UPDATE `tasks` SET `planned_write_id` = NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_planned_write_idx` ON `tasks` (`planned_write_id`);
--> statement-breakpoint
-- The markers that said an Account had its starting Automations, and the
-- Presets it had copied, named rows that are gone.
DELETE FROM `settings`
WHERE `key` in ('baseline-agent-rule:v1', 'baseline-schema-rule:v1', 'morning-automation:v1')
	OR `key` LIKE 'preset-application:%';
--> statement-breakpoint
DELETE FROM `suppressions` WHERE `scope` NOT IN (SELECT `id` FROM `access_tokens`);
--> statement-breakpoint
DROP TABLE `carry_attendance`;
--> statement-breakpoint
DROP TABLE `carry_event_attachments`;
--> statement-breakpoint
DROP TABLE `carry_event_overrides`;
--> statement-breakpoint
DROP TABLE `carry_event_recipients`;
--> statement-breakpoint
DROP TABLE `carry_guest_registrations`;
--> statement-breakpoint
DROP TABLE `carry_chat_turns`;
--> statement-breakpoint
DROP TABLE `carry_chat_attachments`;
--> statement-breakpoint
DROP TABLE `carry_morning_notices`;
--> statement-breakpoint
DROP TABLE `carry_chat_runs`;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
