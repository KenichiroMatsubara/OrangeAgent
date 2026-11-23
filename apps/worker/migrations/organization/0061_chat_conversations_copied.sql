-- Every conversation of the current Operator Chat becomes readable in the
-- chat rebuilt on t3code's chat (ADR 0201), copied into its tables. Nothing
-- of the current chat is rewritten or removed: `chat_conversations`,
-- `chat_turns`, `chat_attachments`, the Runs their exchanges were recorded
-- as, and the bytes R2 holds stay as they are, and the copies name those
-- Runs and those R2 objects.
--
-- A conversation of the current chat is a tree of exchanges, each following
-- the one it was asked after, its siblings the branches beside it. The new
-- chat keeps no branches (ADR 0201), so each path from a first exchange to an
-- exchange nothing follows becomes a conversation of its own, holding its
-- whole path: the path to the exchange changed last keeps the conversation's
-- id and title, and the others take the id `<conversation>-<n>` and the title
-- 「<title>（別の枝 n）」, n counting from 2 in the order their last exchanges
-- last changed. A conversation with no exchange is copied empty.
--
-- Each exchange becomes one answer as the new chat logs it, events numbered
-- per conversation: the member's message with the files sent with it, its
-- Run, each tool the answer called (by name, and why a failed one failed;
-- their arguments and results were never kept), its words with the files it
-- wrote, and, for a failed answer, why it failed. A stopped answer ends as
-- stopped; one still recorded as being written, which nothing writes any
-- longer, ends as failed. Every time is the exchange's own.
--
-- Rows of every shape written since 0022 are read:
-- * `tools` is '[]' for every exchange before 0051 and for one that never
--   ended, else a JSON array of `{ name, state, error? }`, state `finished`
--   or `failed` (`started` only if an answer ever ended unsettled). Anything
--   that is not valid JSON, not an array, or an entry not shaped so is passed
--   over, as the current chat passes it over.
-- * `response` is null for a failed or running exchange and may be '' (a
--   stopped transcription); `error` is null, the failure, or, on a completed
--   exchange, the note that it was stopped.
-- * `parent_turn_id` (0047) may name no exchange of the conversation, or one
--   not before it; such an exchange starts a path, so every walk ends.
-- * times may be '' (0041 coalesced missing ones), so each is read only when
--   it is a date, else the conversation's own, else 1970-01-01.
-- * `chat_attachments` (0039, 0041, 0043): `origin` request or response; a
--   member's file of a kind the current chat no longer accepts is not shown
--   there and is not copied; an object under a `.json` key is an encrypted
--   envelope of the file, which the new chat's file route opens; `media_type`
--   and `filename` may be ''. Where a file was saved in Drive is not copied:
--   the new chat shows no Drive link.
--
-- Every value a schema of the new chat checks is made to pass by
-- construction: names and messages trimmed as t3code trims them and never
-- blank, cut to half their limit in characters so no UTF-16 length exceeds
-- it, a file's size within what a file may be, and words cut at 300,000
-- characters so no event outgrows a D1 row.
--
-- Run again, it copies nothing twice: every id is made from the ids it
-- copies, rows are inserted or ignored, and a conversation that already
-- holds events is given none.
DROP TABLE IF EXISTS `chat_import_turns`;
--> statement-breakpoint
CREATE TABLE `chat_import_turns` AS
WITH RECURSIVE
	`ws` (`chars`) AS (SELECT char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
	`turns` AS (
		SELECT
			`t`.`id`, `t`.`conversation_id`, `t`.`run_id`, `t`.`position`, `t`.`parent_turn_id`,
			`t`.`request`, `t`.`response`, `t`.`status`, `t`.`error`, `t`.`tools`,
			`t`.`asked_by_identity`, `t`.`asked_by_name`,
			CASE WHEN `t`.`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `t`.`created_at`) END AS `created`,
			CASE WHEN `t`.`updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `t`.`updated_at`) END AS `updated`,
			coalesce(
				CASE WHEN `c`.`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `c`.`created_at`) END,
				CASE WHEN `c`.`updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `c`.`updated_at`) END,
				'1970-01-01T00:00:00.000Z'
			) AS `fallback`
		FROM `chat_turns` AS `t`
		JOIN `chat_conversations` AS `c` ON `c`.`id` = `t`.`conversation_id`
		WHERE `t`.`id` IS NOT NULL AND `t`.`run_id` IS NOT NULL AND trim(`t`.`run_id`, (SELECT `chars` FROM `ws`)) <> ''
	),
	`linked` AS (
		SELECT `turns`.*, (
			SELECT `parent`.`id` FROM `turns` AS `parent`
			WHERE `parent`.`id` = `turns`.`parent_turn_id`
				AND `parent`.`conversation_id` = `turns`.`conversation_id`
				AND `parent`.`position` < `turns`.`position`
		) AS `parent_id`
		FROM `turns`
	),
	`leaves` AS (
		SELECT `linked`.`id`, `linked`.`conversation_id`, `linked`.`parent_id`,
			ROW_NUMBER() OVER (
				PARTITION BY `linked`.`conversation_id`
				ORDER BY coalesce(`linked`.`updated`, `linked`.`created`) DESC, `linked`.`position` DESC, `linked`.`id` DESC
			) AS `branch`
		FROM `linked`
		WHERE NOT EXISTS (SELECT 1 FROM `linked` AS `child` WHERE `child`.`parent_id` = `linked`.`id`)
	),
	`walk` (`conversation_id`, `branch`, `turn_id`, `parent_id`) AS (
		SELECT `conversation_id`, `branch`, `id`, `parent_id` FROM `leaves`
		UNION ALL
		SELECT `walk`.`conversation_id`, `walk`.`branch`, `linked`.`id`, `linked`.`parent_id`
		FROM `walk` JOIN `linked` ON `linked`.`id` = `walk`.`parent_id`
	)
SELECT
	CASE WHEN `walk`.`branch` = 1 THEN `walk`.`conversation_id` ELSE `walk`.`conversation_id` || '-' || `walk`.`branch` END AS `thread_id`,
	`walk`.`conversation_id` AS `conversation_id`,
	`walk`.`branch` AS `branch`,
	ROW_NUMBER() OVER (PARTITION BY `walk`.`conversation_id`, `walk`.`branch` ORDER BY `linked`.`position`, `linked`.`id`) AS `depth`,
	`linked`.`id` AS `turn_id`,
	trim(`linked`.`run_id`, (SELECT `chars` FROM `ws`)) AS `run_id`,
	CASE WHEN length(coalesce(`linked`.`request`, '')) > 300000
		THEN substr(`linked`.`request`, 1, 300000) || '…（以下 ' || (length(`linked`.`request`) - 300000) || ' 文字は移すときに省きました）'
		ELSE coalesce(`linked`.`request`, '') END AS `request`,
	CASE WHEN `linked`.`response` IS NULL THEN NULL
		WHEN length(`linked`.`response`) > 300000
		THEN substr(`linked`.`response`, 1, 300000) || '…（以下 ' || (length(`linked`.`response`) - 300000) || ' 文字は移すときに省きました）'
		ELSE `linked`.`response` END AS `response`,
	CASE
		WHEN `linked`.`status` = 'completed' AND `linked`.`error` IS NOT NULL THEN 'stopped'
		WHEN `linked`.`status` = 'completed' THEN 'completed'
		WHEN `linked`.`status` = 'running' THEN 'abandoned'
		ELSE 'failed' END AS `outcome`,
	substr(trim(coalesce(`linked`.`error`, ''), (SELECT `chars` FROM `ws`)), 1, 2048) AS `error`,
	CASE WHEN json_valid(coalesce(`linked`.`tools`, '')) THEN CASE WHEN json_type(`linked`.`tools`) = 'array' THEN `linked`.`tools` ELSE '[]' END ELSE '[]' END AS `tools`,
	coalesce(nullif(substr(trim(coalesce(`runs`.`model`, ''), (SELECT `chars` FROM `ws`)), 1, 200), ''), 'flarechat') AS `model`,
	coalesce(`linked`.`created`, `linked`.`updated`, `linked`.`fallback`) AS `started_at`,
	coalesce(`linked`.`updated`, `linked`.`created`, `linked`.`fallback`) AS `finished_at`,
	`linked`.`asked_by_identity` AS `asked_by_identity`,
	coalesce(`linked`.`asked_by_name`, '') AS `asked_by_name`
FROM `walk`
JOIN `linked` ON `linked`.`id` = `walk`.`turn_id`
LEFT JOIN `runs` ON `runs`.`id` = `linked`.`run_id`;
--> statement-breakpoint
-- One conversation per path, and one, empty, for a conversation with no exchange.
INSERT OR IGNORE INTO `chat_threads` (`id`, `account_id`, `title`, `last_sequence`, `projection`, `projection_sequence`, `created_by_identity`, `created_by_name`, `created_at`, `updated_at`)
WITH
	`ws` (`chars`) AS (SELECT char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
	`conversations` AS (
		SELECT
			`c`.`id`, coalesce(`c`.`account_id`, '') AS `account_id`,
			trim(coalesce(`c`.`title`, ''), (SELECT `chars` FROM `ws`)) AS `title`,
			CASE WHEN `c`.`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `c`.`created_at`) END AS `created`,
			CASE WHEN `c`.`updated_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `c`.`updated_at`) END AS `updated`
		FROM `chat_conversations` AS `c`
		WHERE `c`.`id` IS NOT NULL AND trim(`c`.`id`, (SELECT `chars` FROM `ws`)) <> ''
	),
	`paths` AS (
		SELECT `thread_id`, `conversation_id`, `branch`, min(`started_at`) AS `started`, max(`finished_at`) AS `finished`
		FROM `chat_import_turns` GROUP BY `thread_id`, `conversation_id`, `branch`
	),
	`roots` AS (
		SELECT `thread_id`, `request`, `asked_by_identity`, `asked_by_name` FROM `chat_import_turns` WHERE `depth` = 1
	),
	`named` AS (
		SELECT `paths`.*, `conversations`.`account_id`, `conversations`.`created`, `conversations`.`updated`,
			coalesce(
				nullif(`conversations`.`title`, ''),
				nullif(substr(trim(replace(replace(replace(substr(`roots`.`request`, 1, 400), char(13), ' '), char(10), ' '), char(9), ' '), (SELECT `chars` FROM `ws`)), 1, 80), '')
			) AS `title`,
			`roots`.`asked_by_identity`, `roots`.`asked_by_name`
		FROM `paths`
		JOIN `conversations` ON `conversations`.`id` = `paths`.`conversation_id`
		LEFT JOIN `roots` ON `roots`.`thread_id` = `paths`.`thread_id`
	)
SELECT
	`thread_id`, `account_id`,
	CASE WHEN `branch` = 1 THEN coalesce(`title`, '') ELSE coalesce(`title`, '新しい会話') || '（別の枝 ' || `branch` || '）' END,
	0, NULL, 0,
	`asked_by_identity`, coalesce(`asked_by_name`, ''),
	coalesce(`created`, `started`),
	CASE WHEN `branch` = 1 THEN max(coalesce(`updated`, `finished`), `finished`) ELSE `finished` END
FROM `named`
UNION ALL
SELECT
	`conversations`.`id`, `conversations`.`account_id`, `conversations`.`title`, 0, NULL, 0, NULL, '',
	coalesce(`conversations`.`created`, `conversations`.`updated`, '1970-01-01T00:00:00.000Z'),
	coalesce(`conversations`.`updated`, `conversations`.`created`, '1970-01-01T00:00:00.000Z')
FROM `conversations`
WHERE NOT EXISTS (SELECT 1 FROM `chat_import_turns` WHERE `chat_import_turns`.`conversation_id` = `conversations`.`id`);
--> statement-breakpoint
-- Each file of an exchange, in each conversation whose path holds it, naming the same R2 object.
INSERT OR IGNORE INTO `chat_files` (`id`, `thread_id`, `run_id`, `filename`, `media_type`, `size`, `object_key`, `created_at`, `origin`, `position`)
WITH
	`ws` (`chars`) AS (SELECT char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
SELECT
	CASE WHEN `a`.`id` IS NULL OR `a`.`id` = '' OR length(`a`.`id`) > 100 OR `a`.`id` GLOB '*[^A-Za-z0-9_-]*' THEN 'legacy-' || `a`.`rowid` ELSE `a`.`id` END
		|| CASE WHEN `p`.`branch` = 1 THEN '' ELSE '-' || `p`.`branch` END,
	`p`.`thread_id`,
	`p`.`run_id`,
	coalesce(nullif(trim(coalesce(`a`.`filename`, ''), (SELECT `chars` FROM `ws`)), ''), 'file'),
	coalesce(nullif(trim(coalesce(`a`.`media_type`, ''), (SELECT `chars` FROM `ws`)), ''), 'application/octet-stream'),
	max(coalesce(CAST(`a`.`size` AS INTEGER), 0), 0),
	`a`.`object_key`,
	coalesce(CASE WHEN `a`.`created_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', `a`.`created_at`) END, `p`.`finished_at`),
	CASE WHEN `a`.`origin` = 'response' THEN 'response' ELSE 'request' END,
	coalesce(CAST(`a`.`position` AS INTEGER), 0)
FROM `chat_import_turns` AS `p`
JOIN `chat_attachments` AS `a` ON `a`.`turn_id` = `p`.`turn_id`
WHERE `a`.`object_key` IS NOT NULL AND trim(`a`.`object_key`) <> ''
	AND (`a`.`origin` = 'response' OR `a`.`media_type` IN (
		'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'text/csv', 'text/plain'
	));
--> statement-breakpoint
-- The events of every exchange, numbered per conversation in the order of its path.
INSERT OR IGNORE INTO `chat_events` (`thread_id`, `sequence`, `type`, `payload`, `created_at`)
WITH
	`ws` (`chars`) AS (SELECT char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
	`labels` (`name`, `label`) AS (VALUES
		('query_scheduled_events', '予定を調べる'),
		('query_contacts', '連絡先を調べる'),
		('query_attendance', '出欠を調べる'),
		('tasks.search', 'Google ToDo のタスクを調べる'),
		('tasks.create', 'Google ToDo にタスクを登録する'),
		('tasks.update', 'Google ToDo のタスクを変える'),
		('channel.send', 'メッセージを送る'),
		('reminder.schedule', 'リマインドを予約する'),
		('mail.search', 'メールを検索する'),
		('mail.read', 'メールを読む'),
		('mail.send', 'メールを送る'),
		('mail.draft', 'メールの下書きを保存する'),
		('calendar.search', 'カレンダーを調べる'),
		('drive.search', 'Drive を探す'),
		('drive.read', 'Drive のファイルを読む'),
		('meet.search', 'Meet の会議を調べる'),
		('meet.read', 'Meet の文字起こしを読む'),
		('create_scheduled_event', 'カレンダーに予定を入れる'),
		('update_scheduled_event', 'カレンダーの予定を変える'),
		('cancel_scheduled_event', 'カレンダーの予定を中止する'),
		('attach_event_files', '予定に資料を添付する'),
		('record_event_response', '予定への返信を記録する'),
		('drive.save_file', 'Drive に保存する'),
		('drive.make_pdf', 'PDF にする'),
		('drive.create_folder', 'Drive にフォルダを作る'),
		('drive.move', 'Drive のファイルを移す'),
		('drive.rename', 'Drive のファイルの名前を変える'),
		('drive.trash', 'Drive のファイルをゴミ箱フォルダに入れる'),
		('meet.transcribe', 'Meet の会議を自動で文字起こしする'),
		('skill.write', 'スキルを書き換える'),
		('skill.save_file', 'スキルにファイルを入れる'),
		('skill.delete_file', 'スキルのファイルを削除する'),
		('code_execution', 'ファイルを作る'),
		('report', '読む人に知らせる'),
		('morning.send', '朝のお知らせを送る'),
		('skill.read', 'スキルを読む'),
		('web.search', 'ウェブを調べる'),
		('browser.open', 'ブラウザでページを開く'),
		('browser.read', 'ブラウザの画面を読む'),
		('browser.click', 'ブラウザでクリックする'),
		('browser.type', 'ブラウザで入力する'),
		('browser.select', 'ブラウザで選ぶ'),
		('browser.press', 'ブラウザでキーを押す'),
		('memory.search', '記憶を探す'),
		('run.token', 'プログラムに道具を使わせる'),
		('file.hand', 'ファイルを渡す'),
		('memory.add', '記憶する'),
		('audio.transcribe', '音声を文字起こしする'),
		('query_tasks', 'タスクを調べる'),
		('create_task', 'タスクを登録する'),
		('update_task', 'タスクを変える')
	),
	-- Only a conversation that holds no event yet is given its exchanges.
	`turns` AS (
		SELECT `p`.* FROM `chat_import_turns` AS `p`
		WHERE EXISTS (SELECT 1 FROM `chat_threads` WHERE `chat_threads`.`id` = `p`.`thread_id`)
			AND NOT EXISTS (SELECT 1 FROM `chat_events` WHERE `chat_events`.`thread_id` = `p`.`thread_id`)
	),
	`attached` AS (
		SELECT `f`.`thread_id`, `f`.`run_id`, `f`.`origin`, `f`.`position`, `f`.`id`,
			CASE
				WHEN lower(`f`.`media_type`) LIKE 'image/%' AND length(`f`.`media_type`) <= 100 AND `f`.`size` <= 10485760
				THEN json_object('type', 'image', 'id', `f`.`id`, 'name', substr(trim(`f`.`filename`, (SELECT `chars` FROM `ws`)), 1, 127), 'mimeType', trim(`f`.`media_type`, (SELECT `chars` FROM `ws`)), 'sizeBytes', `f`.`size`)
				ELSE json_object('type', 'file', 'id', `f`.`id`, 'name', substr(trim(`f`.`filename`, (SELECT `chars` FROM `ws`)), 1, 127),
					'mimeType', CASE WHEN length(`f`.`media_type`) <= 100 THEN trim(`f`.`media_type`, (SELECT `chars` FROM `ws`)) ELSE 'application/octet-stream' END,
					'sizeBytes', min(max(`f`.`size`, 1), 52428800))
			END AS `attachment`
		FROM `chat_files` AS `f`
		JOIN (SELECT DISTINCT `thread_id`, `run_id` FROM `turns`) AS `t` ON `t`.`thread_id` = `f`.`thread_id` AND `t`.`run_id` = `f`.`run_id`
		WHERE `f`.`id` NOT GLOB '*[^A-Za-z0-9_-]*' AND length(`f`.`id`) <= 128
	),
	`files` AS (
		SELECT `thread_id`, `run_id`, `origin`, json_group_array(json(`attachment`)) AS `attachments`
		FROM (SELECT * FROM `attached` ORDER BY `thread_id`, `run_id`, `origin`, `position`, `id`)
		GROUP BY `thread_id`, `run_id`, `origin`
	),
	`calls` AS (
		SELECT `t`.`thread_id`, `t`.`run_id`, `t`.`depth`, `t`.`started_at`, `t`.`finished_at`, `e`.`key` AS `sub`,
			substr(trim(json_extract(`e`.`value`, '$.name'), (SELECT `chars` FROM `ws`)), 1, 200) AS `name`,
			json_extract(`e`.`value`, '$.state') AS `state`,
			CASE WHEN json_type(`e`.`value`, '$.error') = 'text' THEN substr(trim(json_extract(`e`.`value`, '$.error'), (SELECT `chars` FROM `ws`)), 1, 16000) END AS `error`
		FROM `turns` AS `t`, json_each(`t`.`tools`) AS `e`
		WHERE `e`.`type` = 'object'
			AND CASE WHEN `e`.`type` = 'object' THEN json_type(`e`.`value`, '$.name') = 'text' AND json_extract(`e`.`value`, '$.state') IN ('started', 'finished', 'failed') ELSE 0 END
			AND CASE WHEN `e`.`type` = 'object' THEN trim(json_extract(`e`.`value`, '$.name'), (SELECT `chars` FROM `ws`)) <> '' ELSE 0 END
	),
	-- Every item of an exchange with its place: the member's message (0), each tool (2), the words (3), and how it ended (4).
	`items` (`thread_id`, `depth`, `step`, `sub`, `at`, `body`) AS (
		SELECT `t`.`thread_id`, `t`.`depth`, 0, 0, `t`.`started_at`, json_object(
			'id', `t`.`run_id` || ':user', 'threadId', `t`.`thread_id`, 'runId', `t`.`run_id`,
			'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL, 'nativeItemRef', NULL, 'parentItemId', NULL,
			'ordinal', 0, 'status', 'completed', 'title', NULL,
			'startedAt', `t`.`started_at`, 'completedAt', `t`.`started_at`, 'updatedAt', `t`.`started_at`,
			'createdBy', 'user', 'creationSource', 'web', 'type', 'user_message', 'messageId', `t`.`run_id` || ':user',
			'inputIntent', 'turn_start', 'text', `t`.`request`,
			'attachments', json(coalesce((SELECT `attachments` FROM `files` WHERE `files`.`thread_id` = `t`.`thread_id` AND `files`.`run_id` = `t`.`run_id` AND `files`.`origin` = 'request'), '[]'))
		)
		FROM `turns` AS `t`
		UNION ALL
		SELECT `c`.`thread_id`, `c`.`depth`, 2, `c`.`sub`, `c`.`started_at`, json_patch(json_object(
			'id', `c`.`run_id` || ':tool:' || `c`.`sub`, 'threadId', `c`.`thread_id`, 'runId', `c`.`run_id`,
			'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL, 'nativeItemRef', NULL, 'parentItemId', NULL,
			'ordinal', 0, 'status', CASE WHEN `c`.`state` = 'finished' THEN 'completed' ELSE 'failed' END,
			'title', (SELECT `label` FROM `labels` WHERE `labels`.`name` = `c`.`name`),
			'startedAt', `c`.`started_at`, 'completedAt', `c`.`finished_at`, 'updatedAt', `c`.`finished_at`,
			'type', 'dynamic_tool', 'toolName', `c`.`name`, 'input', json_object()
		), json_object('output', CASE
			WHEN `c`.`state` = 'started' THEN '回答が終わる前にこのツールは終わりませんでした。'
			WHEN `c`.`state` = 'failed' THEN coalesce(nullif(`c`.`error`, ''), `c`.`name` || ' が失敗しました。')
		END))
		FROM `calls` AS `c`
		UNION ALL
		SELECT `t`.`thread_id`, `t`.`depth`, 3, 0, `t`.`finished_at`, json_patch(json_object(
			'id', `t`.`run_id` || ':text', 'threadId', `t`.`thread_id`, 'runId', `t`.`run_id`,
			'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL, 'nativeItemRef', NULL, 'parentItemId', NULL,
			'ordinal', 0, 'status', CASE WHEN `t`.`outcome` = 'stopped' THEN 'interrupted' ELSE 'completed' END, 'title', NULL,
			'startedAt', `t`.`started_at`, 'completedAt', `t`.`finished_at`, 'updatedAt', `t`.`finished_at`,
			'type', 'assistant_message', 'messageId', `t`.`run_id` || ':text', 'text', coalesce(`t`.`response`, ''), 'streaming', json('false')
		), json_object('attachments', json(`r`.`attachments`)))
		FROM `turns` AS `t`
		LEFT JOIN `files` AS `r` ON `r`.`thread_id` = `t`.`thread_id` AND `r`.`run_id` = `t`.`run_id` AND `r`.`origin` = 'response'
		WHERE `r`.`attachments` IS NOT NULL OR trim(coalesce(`t`.`response`, ''), (SELECT `chars` FROM `ws`)) <> ''
		UNION ALL
		SELECT `t`.`thread_id`, `t`.`depth`, 4, 0, `t`.`finished_at`, json_object(
			'id', `t`.`run_id` || ':error', 'threadId', `t`.`thread_id`, 'runId', `t`.`run_id`,
			'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL, 'nativeItemRef', NULL, 'parentItemId', NULL,
			'ordinal', 0, 'status', 'failed', 'title', NULL,
			'startedAt', `t`.`finished_at`, 'completedAt', `t`.`finished_at`, 'updatedAt', `t`.`finished_at`,
			'type', 'error', 'failure', json_object(
				'class', 'provider_error',
				'message', CASE WHEN `t`.`outcome` = 'failed' AND `t`.`error` <> '' THEN `t`.`error` ELSE '答えを書き終える前に処理が止まりました。もう一度送ってください。' END,
				'code', NULL, 'retryable', NULL
			)
		)
		FROM `turns` AS `t` WHERE `t`.`outcome` IN ('failed', 'abandoned')
		UNION ALL
		SELECT `t`.`thread_id`, `t`.`depth`, 4, 0, `t`.`finished_at`, json_object(
			'id', `t`.`run_id` || ':stopped', 'threadId', `t`.`thread_id`, 'runId', `t`.`run_id`,
			'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL, 'nativeItemRef', NULL, 'parentItemId', NULL,
			'ordinal', 0, 'status', 'completed', 'title', NULL,
			'startedAt', `t`.`finished_at`, 'completedAt', `t`.`finished_at`, 'updatedAt', `t`.`finished_at`,
			'type', 'run_interrupt_result', 'message', '回答を停止しました。'
		)
		FROM `turns` AS `t` WHERE `t`.`outcome` = 'stopped'
	),
	-- Each answer's Run, opened (1) after its message and closed (5) after its items, as the new chat records one.
	`events` (`thread_id`, `depth`, `step`, `sub`, `at`, `type`, `payload`) AS (
		SELECT `thread_id`, `depth`, `step`, `sub`, `at`, 'turn-item.updated',
			json_set(`body`, '$.ordinal', ROW_NUMBER() OVER (PARTITION BY `thread_id` ORDER BY `depth`, `step`, `sub`) - 1)
		FROM `items`
		UNION ALL
		SELECT `t`.`thread_id`, `t`.`depth`, `s`.`step`, 0, CASE WHEN `s`.`step` = 1 THEN `t`.`started_at` ELSE `t`.`finished_at` END,
			CASE WHEN `s`.`step` = 1 THEN 'run.created' ELSE 'run.updated' END,
			json_object(
				'id', `t`.`run_id`, 'threadId', `t`.`thread_id`, 'ordinal', `t`.`depth`,
				'providerInstanceId', 'flarechat', 'modelSelection', json_object('instanceId', 'flarechat', 'model', `t`.`model`),
				'providerThreadId', NULL, 'userMessageId', `t`.`run_id` || ':user', 'rootNodeId', NULL, 'activeAttemptId', NULL,
				'status', CASE WHEN `s`.`step` = 1 THEN 'running' WHEN `t`.`outcome` = 'completed' THEN 'completed' WHEN `t`.`outcome` = 'stopped' THEN 'interrupted' ELSE 'failed' END,
				'requestedAt', `t`.`started_at`, 'startedAt', `t`.`started_at`,
				'completedAt', CASE WHEN `s`.`step` = 1 THEN NULL ELSE `t`.`finished_at` END,
				'checkpointId', NULL, 'contextHandoffId', NULL
			)
		FROM `turns` AS `t`, (SELECT 1 AS `step` UNION ALL SELECT 5) AS `s`
	),
	`numbered` AS (
		SELECT `events`.*, ROW_NUMBER() OVER (PARTITION BY `thread_id` ORDER BY `depth`, `step`, `sub`) AS `sequence` FROM `events`
	)
SELECT
	`thread_id`, `sequence`, `type`,
	json_object('id', 'legacy:' || `thread_id` || ':' || `sequence`, 'threadId', `thread_id`, 'occurredAt', `at`, 'type', `type`, 'payload', json(`payload`)),
	`at`
FROM `numbered`;
--> statement-breakpoint
UPDATE `chat_threads`
SET `last_sequence` = (SELECT max(`sequence`) FROM `chat_events` WHERE `chat_events`.`thread_id` = `chat_threads`.`id`)
WHERE `id` IN (SELECT `thread_id` FROM `chat_import_turns`)
	AND `last_sequence` < coalesce((SELECT max(`sequence`) FROM `chat_events` WHERE `chat_events`.`thread_id` = `chat_threads`.`id`), 0);
--> statement-breakpoint
DROP TABLE `chat_import_turns`;
