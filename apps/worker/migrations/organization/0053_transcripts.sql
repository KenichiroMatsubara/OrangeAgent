-- A recording uploaded on 文字起こし, its transcript, and the minutes written
-- from it, one row each. The recording itself is kept in R2 under
-- `object_key`; `lines` holds the transcript as a JSON array of lines, each
-- with how far into the recording it was said, who said it by voice, and what.
--
-- This only creates a table and its index. No existing row is read or rewritten.
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`state` text DEFAULT 'transcribing' NOT NULL,
	`error` text,
	`model` text NOT NULL,
	`duration_seconds` real,
	`speakers` integer,
	`lines` text DEFAULT '[]' NOT NULL,
	`minutes_state` text,
	`minutes` text,
	`minutes_error` text,
	`minutes_model` text,
	`minutes_instructions` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `transcripts_state_check` CHECK (`state` in ('transcribing', 'completed', 'failed')),
	CONSTRAINT `transcripts_minutes_state_check` CHECK (`minutes_state` IS NULL OR `minutes_state` in ('writing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `transcripts_created_idx` ON `transcripts` (`created_at`);
