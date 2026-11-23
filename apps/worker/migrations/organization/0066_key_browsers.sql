-- The browser an Access Token or an Operator Token keeps open between its MCP
-- calls, each of which arrives as its own request: the Browser Run session
-- and the page the next call reconnects to. A key whose browser outlived its
-- keep-alive starts a new one and overwrites its row.
--
-- A new table that no earlier code wrote, so no row exists for it to fail on.
CREATE TABLE IF NOT EXISTS `key_browsers` (
  `key_id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `target_id` text NOT NULL,
  `updated_at` text NOT NULL
);
