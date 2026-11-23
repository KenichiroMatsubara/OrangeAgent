-- The Operator Chat rebuilt on t3code's chat (ADR 0201) lets a member send
-- files and pictures with a message. They are kept as an answer's files are,
-- in `chat_files`, their bytes in R2, so the route that serves a
-- conversation's files serves them too, and each names the message it came
-- with by `run_id`: the Run of the answer to it, which a queued message is
-- given when it is queued.
--
-- `origin` tells a member's file (`request`) from one an answer wrote or
-- handed on (`response`); `position` keeps a message's files in the order
-- they were sent. Every row kept before this migration is an answer's file,
-- which the defaults say, so no row is read or rewritten.
ALTER TABLE `chat_files` ADD `origin` text DEFAULT 'response' NOT NULL CONSTRAINT "chat_files_origin_check" CHECK("origin" IN ('response', 'request'));
--> statement-breakpoint
ALTER TABLE `chat_files` ADD `position` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `chat_files_run_idx` ON `chat_files` (`run_id`, `origin`, `position`);
