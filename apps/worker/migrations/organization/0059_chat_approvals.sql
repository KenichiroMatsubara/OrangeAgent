-- Approvals of the Operator Chat rebuilt on t3code's chat (ADR 0201).
--
-- `chat_thread_modes` is each conversation's approval mode (read_only, ask,
-- auto, unrestricted) and who last set it and when, so a person's next
-- conversation starts in the mode of the latest one they created or changed.
-- A conversation without a row is in auto.
--
-- `chat_pauses` is an answer waiting for a person to approve one call: at most
-- one per conversation. It names the Run, the call, and its tool, and
-- `state_key` names the R2 object that holds everything the answer did until
-- then (the messages after the member's, the calls still to make, the tokens
-- and tool calls spent), so the answer resumes from it in whichever Durable
-- Object receives the answer. A row is removed the moment the answer is taken.
--
-- `chat_tool_allowances` is every tool a person allowed always for the
-- Account, which no conversation asks about again.
--
-- New tables only: no existing row is read or rewritten.
CREATE TABLE `chat_thread_modes` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`changed_by_identity` text,
	`changed_by_name` text DEFAULT '' NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_thread_modes_mode_check" CHECK("chat_thread_modes"."mode" IN ('read_only', 'ask', 'auto', 'unrestricted'))
);
--> statement-breakpoint
CREATE INDEX `chat_thread_modes_changed_idx` ON `chat_thread_modes` (`changed_by_identity`, `changed_at`);
--> statement-breakpoint
CREATE TABLE `chat_pauses` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`item_id` text NOT NULL,
	`state_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_pauses_thread_idx` ON `chat_pauses` (`thread_id`);
--> statement-breakpoint
CREATE TABLE `chat_tool_allowances` (
	`tool` text PRIMARY KEY NOT NULL,
	`allowed_by_identity` text,
	`allowed_by_name` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
