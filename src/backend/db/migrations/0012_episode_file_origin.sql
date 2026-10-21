ALTER TABLE `episode_files` ADD `origin` text DEFAULT 'import' NOT NULL;--> statement-breakpoint
-- Reclassify rows that were library re-scans, not real imports (History spam).
-- 1) The scanner never stored file_size, so scan/backfill-written rows are the
--    ones with a NULL size (pipeline imports always stat the moved file).
-- 2) A row for the same episode, same path AND same byte size as an earlier
--    row is the same file re-recorded (rescan / duplicate-cleanup re-record).
UPDATE `episode_files` SET `origin` = 'scan'
WHERE `file_size` IS NULL
   OR EXISTS (
     SELECT 1 FROM `episode_files` AS p
     WHERE p.`show_id` = `episode_files`.`show_id`
       AND p.`season_number` = `episode_files`.`season_number`
       AND p.`episode_number` = `episode_files`.`episode_number`
       AND p.`id` < `episode_files`.`id`
       AND p.`file_path` = `episode_files`.`file_path`
       AND p.`file_size` = `episode_files`.`file_size`
   );
