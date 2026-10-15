ALTER TABLE `show_artworks` ADD `image_hash` text;--> statement-breakpoint
ALTER TABLE `show_artworks` ADD `image_path` text;--> statement-breakpoint
ALTER TABLE `show_artworks` ADD `byte_size` integer;--> statement-breakpoint
CREATE INDEX `idx_show_artworks_image_hash` ON `show_artworks` (`image_hash`);