-- Web Push for the Operator Chat rebuilt on t3code's chat (ADR 0201).
-- `push_subscriptions` is one browser a member turned notifications on in:
-- the push service address it handed over (`endpoint`, one row per
-- address, so a browser handed to another member is theirs from then on),
-- the keys its messages are encrypted for, and the words it is shown by.
-- A row is removed when the member turns notifications off there, or when
-- the push service answers that it no longer knows the address.
-- `chat_notices` is each notification a conversation's answer has sent, at
-- most one of each kind per answer, so a conversation's object that went
-- away and came back sends none twice.
--
-- New tables only: no existing row is read or rewritten.
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_idx` ON `push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_identity_idx` ON `push_subscriptions` (`identity_id`);
--> statement-breakpoint
CREATE TABLE `chat_notices` (
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `run_id`, `kind`),
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_notices_kind_check" CHECK("chat_notices"."kind" IN ('approval', 'question', 'completed', 'failed'))
);
