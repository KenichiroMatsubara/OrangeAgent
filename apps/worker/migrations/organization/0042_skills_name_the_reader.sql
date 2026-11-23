-- Every Automation runs at its Trigger Time, and whom it tells is its Skills'.
--
-- A mail arriving and the Morning no longer start an Automation, nothing is
-- kept for a Morning Notice, and the product sends no Task or attendance
-- reminder of its own. The Automations those Triggers started are archived, not
-- removed, because their Runs and the Scheduled Events they made still name
-- them; each Account is given 毎朝のメール処理 and タスクのリマインド in their
-- place at its next tick. An Automation no longer names a Contact List, so a
-- list it named can be removed.
--
-- Every statement touches only rows a release wrote under the shape 0041 left,
-- and none can fail on a row: the updates set columns no check ties to another
-- value but the ones set with them, and the drops remove tables nothing else
-- references.
UPDATE `planned_writes`
SET `status` = 'expired', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` in ('planned', 'pending', 'applying', 'transient_failed', 'blocked')
	AND `run_id` IN (
		SELECT `id` FROM `runs`
		WHERE `trigger` in ('mail', 'morning') AND `status` in ('planning', 'pending_approval', 'applying')
	);
--> statement-breakpoint
UPDATE `runs`
SET `status` = 'expired',
	`finished_at` = COALESCE(`finished_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `trigger` in ('mail', 'morning') AND `status` in ('planning', 'pending_approval', 'applying');
--> statement-breakpoint
UPDATE `automations`
SET `state` = 'archived', `next_run_at` = NULL, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `trigger` in ('mail', 'morning') AND `state` != 'archived';
--> statement-breakpoint
UPDATE `automations` SET `contact_list_id` = NULL WHERE `contact_list_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS `morning_entries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `morning_notices`;
--> statement-breakpoint
DELETE FROM `settings`
WHERE `key` in (
	'task_reminders_enabled',
	'attendance_reminders_enabled',
	'task_reminder_days',
	'attendance_reminder_days',
	'morning_notice_sent_for'
);
