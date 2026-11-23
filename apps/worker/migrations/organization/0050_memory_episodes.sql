-- Memory 2, first stage (ADR 0197). A memory now points at the Episode it was
-- kept from: the words a member typed on 記憶, or the text a run passed to
-- `memory.add`. An Episode is never changed once kept. Each memory also has a
-- status, so a later stage can supersede or forget one without deleting it,
-- and `indexed_at`, which is null until its meaning is in Vectorize.
-- `memory_terms` is the keyword index (character bigrams in an ordinary table,
-- because D1 cannot export a database that holds an FTS5 virtual table), and
-- `memory_changes` records every change to a memory.
--
-- `chat_turns` gains who asked each exchange, for the stage that reads facts
-- out of Operator Chat; existing exchanges keep an unknown asker.
--
-- Existing rows. `memories` has only ever been written by `saveMemory` and
-- `updateMemory` (0048 onward): `content`, `author_kind` (one of three values,
-- checked), and `created_at` are NOT NULL. Each memory gets an Episode with
-- id `legacy-<memory id>`; its hash is built from the memory's id, so two
-- memories with the same words cannot collide on the unique hash. Every
-- part of a NOT NULL value is coalesced, and every insert is OR IGNORE, so
-- no row can fail this file and a rerun changes nothing.
--
-- `automation_tools` rows naming `searchMCPMemory` become `memory.search`.
-- UPDATE OR IGNORE leaves a row whose Automation already names both, and
-- the DELETE after removes it. `automation_revisions.tools` is a record of
-- what was granted and is not rewritten.
--
-- Every memory is left with `indexed_at` null. The background pass finds
-- such memories, builds their `memory_terms` (which SQL cannot split into
-- bigrams), and puts them back into Vectorize without their words in the
-- metadata.
CREATE TABLE `memory_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`member_identity` text,
	`member_name` text DEFAULT '' NOT NULL,
	`conversation_id` text,
	`turn_id` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`state` text NOT NULL,
	`extractor_version` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `memory_episodes_source_check` CHECK (`source` in ('chat', 'cli', 'person', 'legacy')),
	CONSTRAINT `memory_episodes_state_check` CHECK (`state` in ('received', 'extracting', 'committed', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_episodes_hash_idx` ON `memory_episodes` (`content_hash`);
--> statement-breakpoint
CREATE INDEX `memory_episodes_state_idx` ON `memory_episodes` (`state`, `received_at`);
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `episode_id` text REFERENCES `memory_episodes`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `kind` text NOT NULL DEFAULT 'fact' CHECK (`kind` IN ('fact', 'preference', 'event', 'instruction', 'task', 'derived'));
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `speaker` text NOT NULL DEFAULT 'agent' CHECK (`speaker` IN ('user', 'agent', 'tool'));
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `provenance` integer NOT NULL DEFAULT 3 CHECK (`provenance` BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('candidate', 'active', 'superseded', 'rejected', 'forgotten'));
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `evidence_start` integer;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `evidence_end` integer;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `valid_from` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `valid_to` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `indexed_at` text;
--> statement-breakpoint
CREATE INDEX `memories_status_idx` ON `memories` (`status`, `valid_to`);
--> statement-breakpoint
CREATE INDEX `memories_unindexed_idx` ON `memories` (`indexed_at`) WHERE `indexed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `memories_episode_idx` ON `memories` (`episode_id`);
--> statement-breakpoint
CREATE TABLE `memory_terms` (
	`term` text NOT NULL,
	`memory_id` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`term`, `memory_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_terms_memory_idx` ON `memory_terms` (`memory_id`);
--> statement-breakpoint
CREATE TABLE `memory_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`memory_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `memory_changes_memory_idx` ON `memory_changes` (`memory_id`, `at`);
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD COLUMN `asked_by_identity` text;
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD COLUMN `asked_by_name` text NOT NULL DEFAULT '';
--> statement-breakpoint
INSERT OR IGNORE INTO `memory_episodes` (`id`, `source`, `member_name`, `conversation_id`, `turn_id`, `content`, `content_hash`, `state`, `received_at`, `processed_at`)
SELECT
	'legacy-' || `id`,
	'legacy',
	coalesce(`author_name`, ''),
	`conversation_id`,
	`turn_id`,
	coalesce(`content`, ''),
	'legacy:' || `id`,
	'committed',
	coalesce(`created_at`, ''),
	coalesce(`created_at`, '')
FROM `memories`;
--> statement-breakpoint
UPDATE `memories` SET
	`episode_id` = 'legacy-' || `id`,
	`evidence_start` = 0,
	`evidence_end` = length(coalesce(`content`, '')),
	`speaker` = CASE `author_kind` WHEN 'person' THEN 'user' ELSE 'agent' END,
	`provenance` = CASE `author_kind` WHEN 'person' THEN 1 ELSE 3 END,
	`status` = 'active',
	`valid_from` = coalesce(`created_at`, ''),
	`indexed_at` = NULL
WHERE `episode_id` IS NULL AND EXISTS (SELECT 1 FROM `memory_episodes` WHERE `memory_episodes`.`id` = 'legacy-' || `memories`.`id`);
--> statement-breakpoint
INSERT INTO `memory_changes` (`at`, `actor_kind`, `actor_name`, `action`, `memory_id`, `detail`)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'maintenance', '', 'import', `id`, json_object('from', 'mcp-memory')
FROM `memories`
WHERE `episode_id` = 'legacy-' || `id`
	AND NOT EXISTS (SELECT 1 FROM `memory_changes` WHERE `memory_changes`.`memory_id` = `memories`.`id` AND `memory_changes`.`action` = 'import');
--> statement-breakpoint
UPDATE OR IGNORE `automation_tools` SET `tool` = 'memory.search' WHERE `tool` = 'searchMCPMemory';
--> statement-breakpoint
DELETE FROM `automation_tools` WHERE `tool` = 'searchMCPMemory';
