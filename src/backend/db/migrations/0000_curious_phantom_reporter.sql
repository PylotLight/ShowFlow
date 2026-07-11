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
CREATE TABLE `seasons` (
	`show_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`title` text,
	`last_updated` text DEFAULT (datetime('now')),
	PRIMARY KEY(`show_id`, `season_number`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `show_artworks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` text NOT NULL,
	`provider_type` text NOT NULL,
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
CREATE TABLE `show_providers` (
	`show_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_id` text NOT NULL,
	`title` text,
	`original_title` text,
	`year` integer,
	`metadata_json` text,
	`is_primary` integer DEFAULT 0,
	`last_synced` text,
	PRIMARY KEY(`show_id`, `provider_type`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_show_providers_provider` ON `show_providers` (`provider_type`,`provider_id`);--> statement-breakpoint
CREATE TABLE `shows` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`original_title` text,
	`year` integer,
	`profile` text DEFAULT 'standard',
	`config_json` text,
	`root_folder_path` text,
	`sort_title` text,
	`added_at` text DEFAULT (datetime('now')),
	`last_updated` text DEFAULT (datetime('now'))
);
