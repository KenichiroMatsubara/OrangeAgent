-- An Account signs in to a remote MCP Server by OAuth when the server takes no
-- static token. The grant it yields is kept on the server's row, encrypted
-- under the Account's key as the static token is, with why signing in last
-- failed or why the grant stopped working. Both are nullable columns without a
-- default, which read null on every existing row: a server registered before
-- keeps its static token, or none, and is signed in to by no one. No existing
-- row is read or rewritten here.
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_envelope` text;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_error` text;
