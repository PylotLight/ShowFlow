CREATE TABLE `release_blocklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`season_number` integer,
	`episode_numbers` text,
	`release_title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`info_hash` text,
	`indexer_name` text,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_release_blocklist_show` ON `release_blocklist` (`show_id`);--> statement-breakpoint
CREATE INDEX `idx_release_blocklist_title` ON `release_blocklist` (`normalized_title`);--> statement-breakpoint
CREATE INDEX `idx_release_blocklist_hash` ON `release_blocklist` (`info_hash`);--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `status` text DEFAULT 'grabbed' NOT NULL;--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `info_hash` text;--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `release_key` text;--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `grabbed_releases` ADD `failed_at` text;