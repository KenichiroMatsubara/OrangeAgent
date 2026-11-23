-- An Automation may name the model its runs think with, one of those its
-- Account's AI Connection names; null keeps the Connection's default. The
-- model is part of what its runs do, so each Automation Revision records it.
--
-- This only adds two nullable columns without a default. No existing row is
-- read or rewritten; every Automation and revision kept before it reads null,
-- which is the default model every run of it already thought with.
ALTER TABLE `automations` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `automation_revisions` ADD COLUMN `model` text;
