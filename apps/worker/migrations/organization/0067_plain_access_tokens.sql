-- An Access Token is bounded by its Tool Grant alone (ADR 0205): it reaches
-- whom Operator Chat reaches and holds no Suppression Window, so the table
-- drops its Contact List, its Suppression Window, and the call and write
-- counts nothing has read since they stopped being enforced.
--
-- SQLite cannot drop a column a foreign key or a check names, so the table is
-- rebuilt under the same ids. Dropping it deletes its rows first, and that
-- delete cascades to `access_token_tools`, so the grants are carried aside and
-- put back. Foreign keys are checked only when the migration commits.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `carry_access_token_tools` AS SELECT * FROM `access_token_tools`;
--> statement-breakpoint
CREATE TABLE `access_tokens_plain` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `access_tokens_plain` (`id`, `account_id`, `name`, `token_hash`, `last_used_at`, `created_at`, `updated_at`)
SELECT
	`id`,
	coalesce(`account_id`, ''),
	coalesce(`name`, ''),
	coalesce(`token_hash`, `id`),
	`last_used_at`,
	coalesce(`created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	coalesce(`updated_at`, `created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM `access_tokens`
WHERE `id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `access_tokens`;
--> statement-breakpoint
ALTER TABLE `access_tokens_plain` RENAME TO `access_tokens`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_tokens_hash_idx` ON `access_tokens` (`token_hash`);
--> statement-breakpoint
INSERT OR IGNORE INTO `access_token_tools` (`token_id`, `tool`)
SELECT `token_id`, `tool` FROM `carry_access_token_tools`
WHERE `token_id` IN (SELECT `id` FROM `access_tokens`) AND `tool` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `carry_access_token_tools`;
--> statement-breakpoint
-- The repeats a Token's Suppression Window was holding back; no Token holds one now.
DELETE FROM `suppressions` WHERE `scope` IN (SELECT `id` FROM `access_tokens`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
