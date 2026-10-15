CREATE TABLE `episode_status` (
	`show_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`state` text NOT NULL,
	`blocker` text,
	`detail` text,
	`release_title` text,
	`meta_json` text,
	`since` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`show_id`, `season_number`, `episode_number`),
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_episode_status_state` ON `episode_status` (`state`);--> statement-breakpoint
-- Backfill: carry still-missing episodes whose latest pipeline event is a
-- failure into the new table, so existing stuck items keep their reason
-- once the 14-day event retention drops the rows.
INSERT OR IGNORE INTO `episode_status` (`show_id`, `season_number`, `episode_number`, `state`, `blocker`, `detail`, `release_title`, `since`, `updated_at`)
SELECT pe.`show_id`, pe.`season_number`, pe.`episode_number`, 'stuck', COALESCE(pe.`reason_code`, pe.`event_type`), pe.`message`, pe.`release_title`,
  replace(pe.`created_at`, ' ', 'T'), replace(pe.`created_at`, ' ', 'T')
FROM `pipeline_events` pe
JOIN `episodes` e ON e.`show_id` = pe.`show_id` AND e.`season_number` = pe.`season_number` AND e.`episode_number` = pe.`episode_number`
WHERE pe.`stage` = 'FAILED'
  AND (e.`file_path` IS NULL OR e.`file_path` = '')
  AND pe.`id` = (
    SELECT p2.`id` FROM `pipeline_events` p2
    WHERE p2.`show_id` = pe.`show_id` AND p2.`season_number` = pe.`season_number` AND p2.`episode_number` = pe.`episode_number`
    ORDER BY p2.`created_at` DESC, p2.`id` DESC LIMIT 1
  );
