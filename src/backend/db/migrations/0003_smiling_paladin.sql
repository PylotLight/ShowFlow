CREATE TABLE `episode_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`file_path` text NOT NULL,
	`original_name` text NOT NULL,
	`file_size` integer,
	`source_kind` text DEFAULT 'import',
	`release_title` text,
	`indexer_name` text,
	`publish_date` text,
	`imported_at` text DEFAULT (datetime('now')),
	`is_current` integer DEFAULT 1,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_episode_files_show` ON `episode_files` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_episode_files_episode` ON `episode_files` (`show_id`,`season_number`,`episode_number`);--> statement-breakpoint
CREATE INDEX `idx_episode_files_current` ON `episode_files` (`is_current`);--> statement-breakpoint
ALTER TABLE `episodes` ADD `air_time` text;--> statement-breakpoint
ALTER TABLE `episodes` ADD `expected_release_at` text;--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `publish_date` text;--> statement-breakpoint
ALTER TABLE `shows` ADD `release_delay_minutes` integer;