-- An Operator Token lets a member's own CLI or agent act on the Account as
-- Operator Chat does, over the MCP Server, for ninety days. It begins as a
-- Login Code shown to the member on the 接続 screen and becomes the Token when
-- the code is exchanged once; only the hash of each is kept.
--
-- This only creates a table. No existing row is read or rewritten.
CREATE TABLE `operator_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`code_hash` text,
	`code_expires_at` text NOT NULL,
	`token_hash` text,
	`expires_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_tokens_code_idx` ON `operator_tokens` (`code_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_tokens_token_idx` ON `operator_tokens` (`token_hash`);
