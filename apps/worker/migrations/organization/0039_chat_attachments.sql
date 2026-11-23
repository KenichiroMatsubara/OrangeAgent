CREATE TABLE `chat_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`position` integer NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON DELETE cascade,
	UNIQUE (`turn_id`,`position`)
);
