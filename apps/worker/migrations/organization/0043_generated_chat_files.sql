-- An Operator Chat file is either one the administrator sent with a request or
-- one Claude wrote for the answer, and a written file records where it was
-- saved in Drive once it is.
--
-- Every row already in chat_attachments was sent with a request, so each takes
-- the default and none can fail the check; the Drive columns start empty.
ALTER TABLE `chat_attachments` ADD COLUMN `origin` text NOT NULL DEFAULT 'request' CHECK (`origin` IN ('request', 'response'));
--> statement-breakpoint
ALTER TABLE `chat_attachments` ADD COLUMN `drive_file_id` text;
--> statement-breakpoint
ALTER TABLE `chat_attachments` ADD COLUMN `drive_url` text;
