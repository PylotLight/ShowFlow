CREATE TABLE `custom_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`regex` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_terms` (
	`profile_id` text NOT NULL,
	`term_id` text NOT NULL,
	`mode` text NOT NULL,
	`weight` integer,
	PRIMARY KEY(`profile_id`, `term_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `quality_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `model_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `target_resolution` integer;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `min_resolution` integer;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `allow_unknown_resolution` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `skip_sources` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `upgrades_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `upgrade_until_resolution` integer;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `upgrade_until_source` text;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `upgrade_until_score` integer;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `migration_note` text;