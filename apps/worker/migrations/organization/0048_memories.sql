-- The Account's Memory: what Operator Chat's AI, a member's own CLI, or a
-- member on the 記憶 screen chose to keep, one row each. This table is the
-- record; the meaning each memory is searched by is kept beside it in
-- Vectorize, under the memory's id, in the Account's own namespace.
--
-- `memory_uses` records which memories an Operator Chat answer kept or
-- recalled, so its transcript links to them; it goes when the answer or the
-- memory does.
--
-- This only creates tables. No existing row is read or rewritten.
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`conversation_id` text,
	`turn_id` text,
	`edited_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `memories_author_kind_check` CHECK (`author_kind` in ('chat', 'cli', 'person'))
);
--> statement-breakpoint
CREATE INDEX `memories_updated_idx` ON `memories` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `memory_uses` (
	`turn_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`use` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`turn_id`, `memory_id`, `use`),
	FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `memory_uses_use_check` CHECK (`use` in ('saved', 'recalled'))
);
