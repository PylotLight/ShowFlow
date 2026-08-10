CREATE TABLE `episode_mapping_config` (
	`show_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0,
	`source` text DEFAULT 'thexem',
	`health` text DEFAULT 'none',
	`health_detail` text,
	`last_synced` text,
	`last_error` text,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `episode_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`tvdb_id` text,
	`scene_season` integer,
	`scene_episode` integer,
	`scene_absolute` integer,
	`anidb_season` integer,
	`anidb_episode` integer,
	`anidb_absolute` integer,
	`target_season` integer,
	`target_episode` integer,
	`target_absolute` integer,
	`source` text DEFAULT 'thexem' NOT NULL,
	`locked` integer DEFAULT 0,
	`conflict_json` text,
	`scraped_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_episode_mappings_show` ON `episode_mappings` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_episode_mappings_tvdb` ON `episode_mappings` (`tvdb_id`);