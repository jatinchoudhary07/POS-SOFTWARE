ALTER TABLE `dining_tables` ADD `cleared_at` integer;
--> statement-breakpoint
-- Tables that exist today count as cleared now: only paid-and-served orders from before this moment stop holding a table.
UPDATE `dining_tables` SET `cleared_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
