-- A Skill is kept as its folder: every file of a revision, SKILL.md among
-- them, is an object in R2 under skills/{account}/{skill}/{folder}/{path},
-- of whatever kind and as its own bytes. Each revision names the folder that
-- holds it.
--
-- This only adds a column, null for every existing revision: its words and
-- files stay in skill_revisions and skill_files, and the Worker writes them
-- out as a folder the first time it reads that revision. No row is read or
-- rewritten here.
ALTER TABLE `skill_revisions` ADD COLUMN `folder` text;
