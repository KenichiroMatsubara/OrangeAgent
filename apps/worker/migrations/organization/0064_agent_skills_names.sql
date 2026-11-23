-- A Skill is named as the Agent Skills specification names it (ADR 0203):
-- its name is lowercase letters, digits, and single hyphens, at most 64
-- characters, and is also the name of its directory in R2,
-- skills/{account}/{name}/{path}. The name a person reads, often Japanese,
-- becomes the Skill's title, which its SKILL.md keeps as metadata.display-name.
--
-- Every row is kept whatever its name held. The title is the name as it was.
-- The product's starting Skills take the names their words mean; a name of
-- ASCII words is written in lowercase with hyphens; any other name that still
-- breaks the specification becomes skill-<the first 12 hex digits of its id>,
-- which no other row can hold. A rename that would take a name another row
-- holds is skipped, and the next pass names that row by its id instead.
--
-- `directory` names the directory the Skill's files are under. It is null for
-- every existing row, whose files are still where its revision's folder put
-- them: the Worker moves them the first time it reads the Skill, because a
-- migration cannot write to R2, and then records the directory.
ALTER TABLE `skills` ADD COLUMN `title` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `directory` text;
--> statement-breakpoint
UPDATE `skills` SET `title` = COALESCE(`name`, '') WHERE `title` = '';
--> statement-breakpoint
UPDATE OR IGNORE `skills` SET `name` = 'mail-intake' WHERE `name` = 'メールの取り込み';
--> statement-breakpoint
UPDATE OR IGNORE `skills` SET `name` = 'task-reminder' WHERE `name` = 'タスクのリマインド';
--> statement-breakpoint
UPDATE OR IGNORE `skills` SET `name` = 'task-management' WHERE `name` = 'タスクの管理';
--> statement-breakpoint
UPDATE OR IGNORE `skills` SET `name` = 'morning-notice' WHERE `name` = '朝のお知らせ';
--> statement-breakpoint
UPDATE OR IGNORE `skills`
SET `name` = lower(replace(replace(trim(COALESCE(`name`, '')), ' ', '-'), '_', '-'))
WHERE trim(COALESCE(`name`, '')) <> ''
  AND trim(COALESCE(`name`, '')) NOT GLOB '*[^A-Za-z0-9 _-]*';
--> statement-breakpoint
UPDATE OR IGNORE `skills`
SET `name` = 'skill-' || lower(substr(replace(COALESCE(`id`, ''), '-', '') || '000000000000', 1, 12))
WHERE COALESCE(`name`, '') = ''
  OR length(`name`) > 64
  OR `name` GLOB '*[^a-z0-9-]*'
  OR `name` GLOB '-*'
  OR `name` GLOB '*-'
  OR `name` GLOB '*--*';
