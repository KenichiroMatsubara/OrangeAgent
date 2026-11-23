ALTER TABLE `tasks` RENAME TO `tasks_legacy`;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_message_id` text,
	`source_message_subject` text NOT NULL,
	`title` text NOT NULL,
	`deadline` text NOT NULL,
	`assignee_member_id` text,
	`assignee_name` text DEFAULT '未割り当て' NOT NULL,
	`description` text NOT NULL,
	`remarks` text DEFAULT '' NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`scheduled_event_id` text,
	`scheduled_event_title` text,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scheduled_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `tasks_completed_check` CHECK(`tasks`.`completed` in (0, 1))
);
--> statement-breakpoint
INSERT INTO `tasks` (`id`, `organization_id`, `source_message_id`, `source_message_subject`, `title`, `deadline`, `assignee_member_id`, `assignee_name`, `description`, `remarks`, `completed`, `completed_at`, `created_at`, `updated_at`, `scheduled_event_id`, `scheduled_event_title`)
SELECT
	`id`,
	COALESCE(`organization_id`, ''),
	CASE WHEN EXISTS (SELECT 1 FROM `source_messages` WHERE `source_messages`.`id` = `tasks_legacy`.`source_message_id`) THEN `source_message_id` END,
	COALESCE(`source_message_subject`, ''),
	COALESCE(`title`, ''),
	COALESCE(`deadline`, ''),
	`assignee_member_id`,
	COALESCE(`assignee_name`, '未割り当て'),
	COALESCE(`description`, ''),
	COALESCE(`remarks`, ''),
	CASE WHEN `completed` = 1 THEN 1 ELSE 0 END,
	`completed_at`,
	COALESCE(`created_at`, `updated_at`, ''),
	COALESCE(`updated_at`, `created_at`, ''),
	CASE WHEN EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `tasks_legacy`.`scheduled_event_id`) THEN `scheduled_event_id` END,
	`scheduled_event_title`
FROM `tasks_legacy`
WHERE `id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `tasks_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_deadline_title_idx` ON `tasks` (`source_message_id`,`deadline`,`title`);
--> statement-breakpoint
CREATE INDEX `tasks_order_idx` ON `tasks` (`completed`,`deadline`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_member_id`);
--> statement-breakpoint
CREATE INDEX `tasks_scheduled_event_idx` ON `tasks` (`scheduled_event_id`);
