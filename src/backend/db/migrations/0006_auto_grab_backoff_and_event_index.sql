DROP INDEX `idx_pipeline_events_item`;--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_item_latest` ON `pipeline_events` (`show_id`,`season_number`,`episode_number`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `episodes` ADD `last_searched_at` text;--> statement-breakpoint
ALTER TABLE `episodes` ADD `search_attempts` integer DEFAULT 0 NOT NULL;