-- Fails the Runs of the exchanges the chat before ADR 0201 left recorded as
-- being written. That chat closed such a Run only when someone opened its
-- conversation there again, which can no longer happen: its screen and routes
-- are gone, and migration 0061 copied each such exchange as an answer that
-- failed because nothing writes it any longer. The Run is closed as that
-- chat closed one (5b3bda3): status `failed`, the reason as `error`, and
-- `finished_at` and `updated_at` set. Nothing else of the Run is changed —
-- its model, tokens, and tool calls are what it recorded — and nothing of
-- the old chat's own tables is.
--
-- Rows of every shape written since 0041 are read:
-- * `runs.trigger` is 'chat' for every exchange (0041 carried the old chat
--   Runs in as 'chat'; the chat opened every one as 'chat'); an Automation's
--   Run is never 'chat', so none is touched.
-- * `runs.status` of an exchange is 'planning' while it is written (0041
--   carried 'planning' across; the chat opened every Run so), and closing
--   only ever moved it to 'completed' or 'failed'. Only 'planning' is failed,
--   so a Run closed already, whatever its exchange says, stays as it is.
-- * `chat_turns.status` is 'running', 'completed', or 'failed' (0041's
--   check), and `run_id` is NOT NULL and names a Run (0041's foreign key);
--   a turn whose `run_id` names no Run matches nothing.
-- * A Run of the chat built on t3code's is named by no `chat_turns` row:
--   its answers are kept in `chat_events`, and the conversations 0061 copied
--   name only Runs the old chat's turns already named. So no Run of it is
--   touched, nor is one an answer of it is writing now.
-- * Times may be '' or not dates (0041 coalesced missing ones to ''), so
--   `finished_at` is the exchange's own last change when that is a date,
--   else the Run's, else when it started, else now; one already set stays.
-- * `error` keeps what the Run recorded when it is not blank.
--
-- No row can fail it: the status set is one the check allows, no column a
-- check ties to it (`trigger`, `automation_id`, `skills`) changes, and every
-- value set is coalesced to a non-null text. Run again, it changes nothing,
-- as no Run it failed is 'planning' any longer.
UPDATE `runs`
SET
	`status` = 'failed',
	`error` = coalesce(nullif(trim(coalesce(`error`, '')), ''), '答えを書き終える前に処理が止まりました。もう一度送ってください。'),
	`finished_at` = coalesce(
		CASE WHEN `finished_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN `finished_at` END,
		(
			SELECT max(strftime('%Y-%m-%dT%H:%M:%fZ', `t`.`updated_at`)) FROM `chat_turns` AS `t`
			WHERE `t`.`run_id` = `runs`.`id` AND `t`.`updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
		),
		CASE WHEN `updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `updated_at`) END,
		CASE WHEN `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `started_at`) END,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `trigger` = 'chat'
	AND `status` = 'planning'
	AND `id` IN (SELECT `run_id` FROM `chat_turns` WHERE `status` = 'running' AND `run_id` IS NOT NULL);
