ALTER TABLE `shows` ADD `monitor_new_episodes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Backfill existing shows: keep monitoring on only where the user already
-- tracks at least one episode (a show nobody tracks shouldn't suddenly start
-- auto-grabbing). New shows get the column default (1).
UPDATE `shows` SET `monitor_new_episodes` = CASE WHEN EXISTS (
  SELECT 1 FROM `episodes` e WHERE e.`show_id` = `shows`.`id` AND e.`is_tracked` = 1
) THEN 1 ELSE 0 END;
