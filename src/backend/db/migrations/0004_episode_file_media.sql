ALTER TABLE `episode_files` ADD `container` text;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `video_width` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `video_height` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `video_codec` text;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `video_fps` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `hdr` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `audio_codec` text;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `audio_channels` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `duration_seconds` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `bitrate_kbps` integer;--> statement-breakpoint
ALTER TABLE `episode_files` ADD `probed_at` text;