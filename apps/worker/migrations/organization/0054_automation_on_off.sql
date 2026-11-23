-- An Automation is on or off, and nothing else.
--
-- The four states draft, active, suspended, and archived become one flag:
-- an active Automation is on, and every other one is off. An off one still
-- keeps its Runs and can still be tried from its page.
--
-- `state` was written only under its NOT NULL check, which allows exactly the
-- four values, so every row reads one of them and the backfill below cannot
-- fail on any row. The new column is added NOT NULL with a default its check
-- accepts, so adding it cannot fail either. `state` itself stays in the table
-- unread, because SQLite cannot drop a column a table check names; the index
-- that served it is replaced by one on the flag.
ALTER TABLE `automations` ADD COLUMN `enabled` integer DEFAULT 0 NOT NULL CHECK (`enabled` in (0, 1));
--> statement-breakpoint
UPDATE `automations` SET `enabled` = 1 WHERE `state` = 'active';
--> statement-breakpoint
UPDATE `automations` SET `next_run_at` = NULL WHERE `enabled` = 0 AND `next_run_at` IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `automations_due_idx`;
--> statement-breakpoint
CREATE INDEX `automations_due_idx` ON `automations` (`enabled`, `next_run_at`);
