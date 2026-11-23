-- Operator Chat rebuilt on t3code's chat (ADR 0201) keeps each conversation
-- as a log of events numbered per conversation. `chat_threads` is one
-- conversation: its title, the sequence of its latest event, and, once an
-- answer ends, the conversation as it then stood (`projection`, the
-- snapshot's encoded projection at `projection_sequence`), so it is not
-- rebuilt from every event each time it is opened. `chat_events` is the log
-- itself, one row per event, its payload the event as its JSON encoding.
-- `chat_files` is every file an answer wrote or handed the member, whose
-- bytes R2 holds under `object_key`. Each answer is still recorded as one Run
-- (ADR 0146), named by the events, not by a foreign key, so deleting a
-- conversation keeps its Runs.
--
-- New tables only: no existing row is read or rewritten, and the current
-- chat's tables are left as they are.
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`title` text NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`projection` text,
	`projection_sequence` integer DEFAULT 0 NOT NULL,
	`created_by_identity` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_threads_recent_idx` ON `chat_threads` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `chat_events` (
	`thread_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `sequence`),
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_files` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_files_thread_idx` ON `chat_files` (`thread_id`, `filename`);
