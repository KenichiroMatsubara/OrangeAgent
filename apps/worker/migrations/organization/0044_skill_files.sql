-- A Skill carries files beside its instructions — examples, templates, and
-- reference material its instructions point to — and each revision keeps the
-- files it had, so a run names the exact words and files it could read.
--
-- This only creates a table: no row is read or rewritten, and every existing
-- Skill revision simply has no files.
CREATE TABLE `skill_files` (
	`skill_id` text NOT NULL,
	`revision` integer NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`skill_id`, `revision`, `path`),
	FOREIGN KEY (`skill_id`, `revision`) REFERENCES `skill_revisions`(`skill_id`, `revision`) ON DELETE cascade
);
