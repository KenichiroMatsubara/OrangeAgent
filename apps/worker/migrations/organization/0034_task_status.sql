ALTER TABLE `tasks` RENAME TO `tasks_legacy`;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_message_id` text,
	`source_message_subject` text NOT NULL,
	`rule_effect_id` text,
	`link_token` text,
	`title` text NOT NULL,
	`deadline` text,
	`assignee_member_id` text,
	`assignee_name` text DEFAULT '未割り当て' NOT NULL,
	`description` text NOT NULL,
	`remarks` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`completed_via` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`scheduled_event_id` text,
	`scheduled_event_title` text,
	FOREIGN KEY (`source_message_id`) REFERENCES `source_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scheduled_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `tasks_status_check` CHECK(`tasks`.`status` in ('open', 'completed', 'cancelled')),
	CONSTRAINT `tasks_completed_via_check` CHECK(`tasks`.`completed_via` IS NULL OR `tasks`.`completed_via` in ('account', 'agent', 'contact_page', 'task_link')),
	CONSTRAINT `tasks_completed_check` CHECK(`tasks`.`completed` in (0, 1))
);
--> statement-breakpoint
INSERT INTO `tasks` (`id`, `organization_id`, `source_message_id`, `source_message_subject`, `rule_effect_id`, `link_token`, `title`, `deadline`, `assignee_member_id`, `assignee_name`, `description`, `remarks`, `status`, `completed`, `completed_at`, `completed_via`, `created_at`, `updated_at`, `scheduled_event_id`, `scheduled_event_title`)
SELECT
	`id`,
	COALESCE(`organization_id`, ''),
	CASE WHEN EXISTS (SELECT 1 FROM `source_messages` WHERE `source_messages`.`id` = `tasks_legacy`.`source_message_id`) THEN `source_message_id` END,
	COALESCE(`source_message_subject`, ''),
	NULL,
	lower(hex(randomblob(24))),
	COALESCE(`title`, ''),
	COALESCE(`deadline`, ''),
	`assignee_member_id`,
	COALESCE(`assignee_name`, '未割り当て'),
	COALESCE(`description`, ''),
	COALESCE(`remarks`, ''),
	CASE WHEN `completed` = 1 THEN 'completed' ELSE 'open' END,
	CASE WHEN `completed` = 1 THEN 1 ELSE 0 END,
	`completed_at`,
	NULL,
	COALESCE(`created_at`, `updated_at`, ''),
	COALESCE(`updated_at`, `created_at`, ''),
	CASE WHEN EXISTS (SELECT 1 FROM `events` WHERE `events`.`id` = `tasks_legacy`.`scheduled_event_id`) THEN `scheduled_event_id` END,
	`scheduled_event_title`
FROM `tasks_legacy`
WHERE `id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `tasks_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_rule_effect_idx` ON `tasks` (`rule_effect_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_link_token_idx` ON `tasks` (`link_token`);
--> statement-breakpoint
CREATE INDEX `tasks_order_idx` ON `tasks` (`status`, `deadline`);
--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_member_id`);
--> statement-breakpoint
CREATE INDEX `tasks_scheduled_event_idx` ON `tasks` (`scheduled_event_id`);
--> statement-breakpoint
CREATE INDEX `tasks_updated_idx` ON `tasks` (`updated_at`);
