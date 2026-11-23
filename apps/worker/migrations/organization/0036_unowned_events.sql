DROP TRIGGER IF EXISTS `events_owning_rule_insert_check`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `events_owning_rule_update_check`;
--> statement-breakpoint
CREATE TRIGGER `events_owning_rule_insert_check`
BEFORE INSERT ON `events`
WHEN NEW.`rule_id` IS NOT NULL AND NEW.`agent_rule_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'Scheduled Event has at most one Owning Rule');
END;
--> statement-breakpoint
CREATE TRIGGER `events_owning_rule_update_check`
BEFORE UPDATE OF `rule_id`, `agent_rule_id` ON `events`
WHEN NEW.`rule_id` IS NOT NULL AND NEW.`agent_rule_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'Scheduled Event has at most one Owning Rule');
END;
