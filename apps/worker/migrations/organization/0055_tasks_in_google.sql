-- Tasks move to Google Tasks (ADR 0198). A Task FlareChat kept is copied into
-- Google Tasks by the Worker, which a migration cannot do, so each row records
-- the Google task it became: a nullable column without a default, which reads
-- null on every existing row until its copy is made. No existing row is read
-- or rewritten here.
ALTER TABLE `tasks` ADD COLUMN `google_task_id` text;
--> statement-breakpoint
-- A Tool Grant names tools, and the three Task tools are replaced by the three
-- that reach Google Tasks, so an Automation granted one keeps what it could do.
-- `automation_tools` is keyed by (automation_id, tool): OR IGNORE leaves a row
-- whose new name is already granted, and the DELETE then removes it.
UPDATE OR IGNORE `automation_tools` SET `tool` = 'tasks.search' WHERE `tool` = 'query_tasks';
--> statement-breakpoint
UPDATE OR IGNORE `automation_tools` SET `tool` = 'tasks.create' WHERE `tool` = 'create_task';
--> statement-breakpoint
UPDATE OR IGNORE `automation_tools` SET `tool` = 'tasks.update' WHERE `tool` = 'update_task';
--> statement-breakpoint
DELETE FROM `automation_tools` WHERE `tool` IN ('query_tasks', 'create_task', 'update_task');
--> statement-breakpoint
-- An Access Token holds no Google grant, so it reaches no Task any more.
DELETE FROM `access_token_tools` WHERE `tool` IN ('query_tasks', 'create_task', 'update_task');
