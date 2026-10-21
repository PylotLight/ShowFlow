ALTER TABLE `episodes` ADD `upgrade_misses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `episodes` ADD `upgrade_cutoff_key` text;