UPDATE `tasks` SET `status` = CASE WHEN `completed` = 1 THEN 'completed' ELSE 'open' END WHERE `status` <> 'cancelled';
--> statement-breakpoint
UPDATE `tasks` SET `deadline` = CASE
		WHEN `deadline` GLOB '*Z' OR `deadline` GLOB '*[+-][0-9][0-9]:[0-9][0-9]' THEN date(`deadline`, '+9 hours')
		ELSE substr(`deadline`, 1, 10)
	END
WHERE substr(`deadline`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND substr(`deadline`, 11, 1) IN ('T', ' ')
	AND substr(`deadline`, 12, 5) GLOB '[0-9][0-9]:[0-9][0-9]'
	AND date(substr(`deadline`, 1, 10)) = substr(`deadline`, 1, 10)
	AND datetime(`deadline`) IS NOT NULL;
--> statement-breakpoint
UPDATE `tasks` SET
	`description` = CASE
		WHEN TRIM(COALESCE(`deadline`, '')) = '' THEN `description`
		WHEN `description` = '' THEN '元の締切: ' || `deadline`
		ELSE `description` || char(10) || char(10) || '元の締切: ' || `deadline`
	END,
	`deadline` = NULL
WHERE `deadline` IS NOT NULL
	AND NOT (`deadline` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(`deadline`) = `deadline`);
