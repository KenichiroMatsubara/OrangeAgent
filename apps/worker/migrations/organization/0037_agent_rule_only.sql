-- Every Schema Rule still in use becomes an Agent Rule with the same selection,
-- Execution Mode, priority, report readers, and permitted lists, run by a Prompt
-- that states what the Schema Rule did (ADR 0137). The Schema Rule is then
-- archived: its rows stay, because Scheduled Events and Rule Runs name it as
-- their history, and nothing runs it any more.
ALTER TABLE `agent_rules` ADD `notice_contact_list_id` text REFERENCES contact_lists(id);
--> statement-breakpoint
INSERT OR IGNORE INTO `prompts` (`id`, `organization_id`, `name`, `instructions`, `current_revision`, `published`, `created_at`, `updated_at`)
SELECT 'intake-prompt-' || `id`, `organization_id`, 'メールの取り込み（' || COALESCE(NULLIF(TRIM(`name`), ''), `id`) || '）',
'届いたメール（Source Message）を 1 通ずつ読み、この Account の予定・タスク・連絡を整えてください。

1. メールが何かを決めます。行事・会議の案内か、案内済みの予定の変更・中止か、案内済みの予定への返信（出欠の返事、受付の確認、申込書の返送など）か、そのどれでもないお知らせか。引用された過去のメールではなく、この送信者がこのメールで何をしているかで判断します。
2. 案内の場合は、日付と開始時刻が書かれている催しごとに予定を 1 件ずつ作ります（式典と懇親会のように、それぞれに日時があれば別の予定です）。すでに一覧にある予定は作り直さず、変わった点だけを変更します。終了時刻が書かれていないときは開始の 2 時間後を終了とし、予定の説明の先頭に「終了時間を抽出できませんでした。2時間後を終了時間としました。」と書きます。予定には inviteRoster を true にして、この Account の連絡先全員を招待します。メールの添付ファイルは、関係する予定に添付します。
3. 変更・中止の場合は、該当する予定を変更し、中止が明記されているときだけ中止します。新しい版の資料が届いたら、古い資料と差し替えます。
4. 返信の場合は予定を作らず、返信している予定に record_event_response で記録します。申込書などで外部の参加者が書かれていれば、その人数を所属ごとに記録します。添付ファイルがあれば、その予定に添付します。
5. 最後に report を 1 回だけ呼び、メール全体と添付の要約を日本語で簡潔に書きます。目的と、日時・締め切り・費用・必要な対応など書かれている事実を含め、書かれていないことは補いません。',
1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `rules`
WHERE `status` <> 'archived';
--> statement-breakpoint
INSERT OR IGNORE INTO `prompt_revisions` (`prompt_id`, `revision`, `instructions`, `created_at`)
SELECT `id`, 1, `instructions`, `created_at`
FROM `prompts`
WHERE `id` IN (SELECT 'intake-prompt-' || `id` FROM `rules` WHERE `status` <> 'archived');
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_rules` (`id`, `organization_id`, `name`, `status`, `execution_mode`, `prompt_id`, `selection_policy`, `priority`, `notice_contact_list_id`, `current_revision`, `created_at`, `updated_at`)
SELECT 'agent-' || `rules`.`id`,
	`rules`.`organization_id`,
	COALESCE(NULLIF(TRIM(`rules`.`name`), ''), 'すべてのメール'),
	`rules`.`status`,
	CASE WHEN `rules`.`execution_mode` IN ('read_only', 'approval', 'unattended') THEN `rules`.`execution_mode` ELSE 'unattended' END,
	'intake-prompt-' || `rules`.`id`,
	CASE WHEN json_valid(COALESCE(`rules`.`selection_policy`, '')) THEN
		CASE WHEN json_type(`rules`.`selection_policy`) = 'object' THEN `rules`.`selection_policy` ELSE '{}' END
	ELSE '{}' END,
	COALESCE(`rules`.`priority`, 0),
	(SELECT `contact_lists`.`id` FROM `contact_lists` WHERE `contact_lists`.`id` = `rules`.`notice_contact_list_id`),
	1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `rules`
WHERE `rules`.`status` <> 'archived'
	AND EXISTS (SELECT 1 FROM `prompts` WHERE `prompts`.`id` = 'intake-prompt-' || `rules`.`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_rule_permitted_recipient_lists` (`agent_rule_id`, `list_id`)
SELECT 'agent-' || `rule_id`, `list_id`
FROM `rule_permitted_recipient_lists`
WHERE 'agent-' || `rule_id` IN (SELECT `id` FROM `agent_rules`)
	AND `list_id` IN (SELECT `id` FROM `lists`);
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_rule_permitted_line_lists` (`agent_rule_id`, `list_id`)
SELECT 'agent-' || `rule_id`, `list_id`
FROM `rule_permitted_line_lists`
WHERE 'agent-' || `rule_id` IN (SELECT `id` FROM `agent_rules`)
	AND `list_id` IN (SELECT `id` FROM `lists`);
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_rule_revisions` (`id`, `agent_rule_id`, `revision`, `prompt_id`, `selection_policy`, `execution_mode`, `permitted_recipient_list_ids`, `permitted_line_list_ids`, `created_at`)
SELECT 'agent-revision-' || `agent_rules`.`id`, `agent_rules`.`id`, 1, `agent_rules`.`prompt_id`, `agent_rules`.`selection_policy`, `agent_rules`.`execution_mode`,
	(SELECT json_group_array(`list_id`) FROM `agent_rule_permitted_recipient_lists` WHERE `agent_rule_id` = `agent_rules`.`id`),
	(SELECT json_group_array(`list_id`) FROM `agent_rule_permitted_line_lists` WHERE `agent_rule_id` = `agent_rules`.`id`),
	`agent_rules`.`created_at`
FROM `agent_rules`
WHERE `agent_rules`.`id` IN (SELECT 'agent-' || `id` FROM `rules` WHERE `status` <> 'archived');
--> statement-breakpoint
UPDATE `rules`
SET `status` = 'archived', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` <> 'archived'
	AND 'agent-' || `id` IN (SELECT `id` FROM `agent_rules`);
