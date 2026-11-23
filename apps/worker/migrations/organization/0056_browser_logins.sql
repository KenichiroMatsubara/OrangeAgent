-- The sites the Account's browser is signed in to (ADR 0200). A person signs
-- in once through Browser Run's Live View; what the browser then holds of the
-- sign-in, its cookies and localStorage, is kept under the Account's envelope
-- encryption in `state_envelope`, null until the sign-in is first saved. While
-- a person is signing in, `session_id` and `target_id` name the Browser Run
-- session and tab they are signing in through. A new table: no existing row is
-- read or rewritten.
CREATE TABLE `browser_logins` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`site` text NOT NULL,
	`url` text NOT NULL,
	`state_envelope` text,
	`session_id` text,
	`target_id` text,
	`saved_at` text,
	`used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_logins_site_idx` ON `browser_logins` (`site`);
