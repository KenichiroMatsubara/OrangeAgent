-- An Account may sign in to a remote MCP Server with an OAuth client it
-- registered itself, for an authorization server that registers no client on
-- request, as Google's Workspace MCP servers do not. Its client ID, secret and
-- scopes are kept on the server's row, encrypted under the Account's key as
-- the static token is. The column is nullable without a default, so every
-- existing row reads null: a server registered before keeps signing in as it
-- did, by registering OrangeAgent with its authorization server. No existing
-- row is read or rewritten here.
ALTER TABLE `mcp_servers` ADD COLUMN `oauth_client_envelope` text;
