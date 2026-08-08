CREATE TABLE `grabbed_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`season_number` integer,
	`episode_number` integer,
	`release_title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`indexer_name` text,
	`grabbed_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_grabbed_releases_title` ON `grabbed_releases` (`normalized_title`);--> statement-breakpoint
CREATE INDEX `idx_grabbed_releases_show` ON `grabbed_releases` (`show_id`);