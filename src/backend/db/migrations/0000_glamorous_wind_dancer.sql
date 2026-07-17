CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text DEFAULT (CURRENT_TIMESTAMP),
	`event_type` text,
	`entity_type` text,
	`entity_id` text,
	`message` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `custom_formats` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`regex` text NOT NULL,
	`score` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`show_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_number` integer,
	`title` text,
	`file_path` text,
	`is_tracked` integer DEFAULT 0,
	`air_date` text,
	`search_mode` text DEFAULT 'auto',
	`last_updated` text DEFAULT (datetime('now')),
	PRIMARY KEY(`show_id`, `season_number`, `episode_number`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `metadata_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`raw_json` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `pipeline_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`season_number` integer,
	`episode_number` integer,
	`stage` text NOT NULL,
	`event_type` text NOT NULL,
	`reason_code` text,
	`reason_category` text,
	`message` text NOT NULL,
	`release_title` text,
	`indexer_name` text,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_item` ON `pipeline_events` (`show_id`,`season_number`,`episode_number`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_created_at` ON `pipeline_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_stage` ON `pipeline_events` (`stage`);--> statement-breakpoint
CREATE TABLE `processed_files` (
	`file_hash` text PRIMARY KEY NOT NULL,
	`original_path` text,
	`final_path` text,
	`timestamp` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `profile_formats` (
	`profile_id` text NOT NULL,
	`format_id` text NOT NULL,
	`type` text DEFAULT 'bonus',
	PRIMARY KEY(`profile_id`, `format_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `quality_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`format_id`) REFERENCES `custom_formats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `profile_qualities` (
	`profile_id` text NOT NULL,
	`quality_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `quality_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `quality_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quality_id`) REFERENCES `quality_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `quality_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rank` integer DEFAULT 0,
	`min_size` integer,
	`max_size` integer
);
--> statement-breakpoint
CREATE TABLE `quality_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cutoff_quality_id` text,
	`indexers` text DEFAULT '{}',
	FOREIGN KEY (`cutoff_quality_id`) REFERENCES `quality_definitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`name` text PRIMARY KEY NOT NULL,
	`interval_minutes` integer,
	`last_execution` text,
	`last_duration_ms` integer,
	`next_execution` text,
	`enabled` integer DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`show_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`title` text,
	`last_updated` text DEFAULT (datetime('now')),
	PRIMARY KEY(`show_id`, `season_number`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `show_artworks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`provider_type` text DEFAULT 'local' NOT NULL,
	`artwork_type` text NOT NULL,
	`image_url` text NOT NULL,
	`width` integer,
	`height` integer,
	`thumbnail` text,
	`content_type` text,
	`data` blob,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_show_artworks` ON `show_artworks` (`show_id`,`provider_type`,`artwork_type`);--> statement-breakpoint
CREATE TABLE `show_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_folder_path` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `show_providers` (
	`show_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_id` text NOT NULL,
	`title` text,
	`original_title` text,
	`year` integer,
	`metadata_json` text,
	`is_primary` integer DEFAULT 0,
	`is_metadata` integer DEFAULT 0,
	`is_airtime` integer DEFAULT 0,
	`last_synced` text,
	PRIMARY KEY(`show_id`, `provider_type`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_show_providers_provider` ON `show_providers` (`provider_type`,`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_show_providers_show_id` ON `show_providers` (`show_id`);--> statement-breakpoint
CREATE TABLE `show_titles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`language` text,
	`title_type` text NOT NULL,
	`provider_type` text,
	`created_at` text DEFAULT (datetime('now')),
	`last_updated` text DEFAULT (datetime('now')),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_show_titles_normalized_title` ON `show_titles` (`normalized_title`);--> statement-breakpoint
CREATE INDEX `idx_show_titles_show_id` ON `show_titles` (`show_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_show_titles_show_normalized_type` ON `show_titles` (`show_id`,`normalized_title`,`title_type`,`provider_type`);--> statement-breakpoint
CREATE TABLE `shows` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`original_title` text,
	`year` integer,
	`profile` text DEFAULT 'standard',
	`series_type` text DEFAULT 'standard',
	`root_folder_path` text,
	`sort_title` text,
	`added_at` text DEFAULT (datetime('now')),
	`last_updated` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `system_health` (
	`component_type` text NOT NULL,
	`component_id` text NOT NULL,
	`component_name` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`reason_category` text,
	`message` text,
	`metadata_json` text,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`component_type`, `component_id`)
);
