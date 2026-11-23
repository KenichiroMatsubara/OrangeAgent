-- Proposed Actions were how an Agent Rule's writes waited for approval before
-- Rule Execution existed. Migration 0021 copied every row into rule_runs and
-- rule_effects, the code that wrote the table was removed in the same release,
-- and nothing reads it since, so it goes. No table references it.
DROP INDEX IF EXISTS `proposed_actions_run_idx`;
--> statement-breakpoint
DROP TABLE IF EXISTS `proposed_actions`;
