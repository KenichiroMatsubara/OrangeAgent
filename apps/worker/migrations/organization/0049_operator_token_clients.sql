-- An Operator Token may now also be granted to an OAuth client, such as Claude,
-- that a member approved on the authorization screen. The row keeps which
-- client asked, where its code may be sent, the PKCE challenge its code is
-- exchanged against, when its current access token stops working, and the
-- hash of the refresh token that replaces it. A Token issued for a Login Code
-- leaves every one of them null.
--
-- This only adds nullable columns and an index over one of them. No existing
-- row is read or rewritten, and every existing row keeps working as it did.
ALTER TABLE `operator_tokens` ADD `client_id` text;
--> statement-breakpoint
ALTER TABLE `operator_tokens` ADD `client_name` text;
--> statement-breakpoint
ALTER TABLE `operator_tokens` ADD `redirect_uri` text;
--> statement-breakpoint
ALTER TABLE `operator_tokens` ADD `code_challenge` text;
--> statement-breakpoint
ALTER TABLE `operator_tokens` ADD `access_expires_at` text;
--> statement-breakpoint
ALTER TABLE `operator_tokens` ADD `refresh_hash` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_tokens_refresh_idx` ON `operator_tokens` (`refresh_hash`);
