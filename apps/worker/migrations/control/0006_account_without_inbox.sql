ALTER TABLE `organization_provisionings` RENAME TO `organization_provisionings_legacy`;
--> statement-breakpoint
DROP INDEX IF EXISTS `organization_provisionings_owner_identity_id_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `organization_provisionings_provisioning_key_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `provisionings_state_expiry_idx`;
--> statement-breakpoint
CREATE TABLE `organization_provisionings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`owner_identity_id` text NOT NULL,
	`state` text NOT NULL,
	`phase` text,
	`inbox_address` text,
	`google_subject` text,
	`granted_scopes` text,
	`credential_envelope` text,
	`history_id` text,
	`database_id` text,
	`binding_name` text NOT NULL,
	`provisioning_key` text NOT NULL,
	`preset_id` text,
	`error_message` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_provisionings_state_check" CHECK("organization_provisionings"."state" in ('provisioning', 'failed')),
	CONSTRAINT "organization_provisionings_phase_check" CHECK("organization_provisionings"."phase" is null or "organization_provisionings"."phase" in ('allocating_database', 'applying_schema', 'storing_credentials', 'verifying_binding', 'activating_organization'))
);
--> statement-breakpoint
INSERT INTO `organization_provisionings` (
	`organization_id`, `owner_identity_id`, `state`, `phase`, `inbox_address`, `google_subject`, `granted_scopes`,
	`credential_envelope`, `history_id`, `database_id`, `binding_name`, `provisioning_key`, `preset_id`,
	`error_message`, `expires_at`, `created_at`, `updated_at`
)
SELECT
	`organization_id`, `owner_identity_id`, `state`, `phase`, `inbox_address`, `google_subject`, `granted_scopes`,
	`credential_envelope`, `history_id`, `database_id`, `binding_name`, `provisioning_key`, `preset_id`,
	`error_message`, `expires_at`, `created_at`, `updated_at`
FROM `organization_provisionings_legacy`;
--> statement-breakpoint
DROP TABLE `organization_provisionings_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_provisionings_owner_identity_id_unique` ON `organization_provisionings` (`owner_identity_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_provisionings_provisioning_key_unique` ON `organization_provisionings` (`provisioning_key`);
--> statement-breakpoint
CREATE INDEX `provisionings_state_expiry_idx` ON `organization_provisionings` (`state`,`expires_at`);
