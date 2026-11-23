-- The Morning Notice is about to be written by a Morning Automation, a Prompt
-- the Account can rewrite, rather than composed by fixed code alone. This
-- release only reshapes the schema and touches no existing row's meaning.
--
-- An Automation states which Trigger starts it: a Trigger Time, as every
-- Automation so far has, or the Morning. Every existing row keeps the default.
ALTER TABLE `automations` ADD `trigger_kind` text DEFAULT 'schedule' NOT NULL CONSTRAINT `automations_trigger_check` CHECK (`trigger_kind` in ('schedule', 'morning'));
--> statement-breakpoint
-- One address's Morning Notice for one Morning, exactly as it is sent: the
-- texts the Morning Automation's send was accepted with, or the fixed
-- composition. A retry sends these texts again rather than composing anew.
CREATE TABLE `morning_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`morning` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`texts` text NOT NULL,
	`composed_by` text NOT NULL,
	`automation_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`automation_run_id`) REFERENCES `automation_runs`(`id`) ON DELETE set null,
	CONSTRAINT `morning_notices_channel_check` CHECK (`channel` in ('email', 'line', 'discord')),
	CONSTRAINT `morning_notices_composed_by_check` CHECK (`composed_by` in ('automation', 'fixed'))
);
--> statement-breakpoint
CREATE INDEX `morning_notices_address_idx` ON `morning_notices` (`morning`, `channel`, `destination`);
--> statement-breakpoint
-- The Morning Notice that carries an entry, once one has been composed for it.
-- An entry kept before this release carries none and is composed as it always was.
ALTER TABLE `morning_entries` ADD `notice_id` text REFERENCES morning_notices(id);
--> statement-breakpoint
-- What the entry is, so the Morning Automation can be told: a Source Message
-- Notice, an Intake Notice, a channel message or a mail an Agent Rule wrote, or
-- a reminder. Entries kept before this release carry none.
ALTER TABLE `morning_entries` ADD `kind` text;
--> statement-breakpoint
CREATE INDEX `morning_entries_notice_idx` ON `morning_entries` (`notice_id`);
