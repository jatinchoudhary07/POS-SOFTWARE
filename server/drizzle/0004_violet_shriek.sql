CREATE TABLE `bill_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_orders_order_unique` ON `bill_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `bill_orders_bill_idx` ON `bill_orders` (`bill_id`);--> statement-breakpoint
CREATE INDEX `bill_orders_order_idx` ON `bill_orders` (`order_id`);--> statement-breakpoint
DROP INDEX `dining_tables_name_unique`;--> statement-breakpoint
ALTER TABLE `dining_tables` ADD `capacity` integer;--> statement-breakpoint
ALTER TABLE `dining_tables` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `dining_tables_active_name_unique` ON `dining_tables` (lower("name")) WHERE is_active = 1;--> statement-breakpoint
ALTER TABLE `bills` ADD `table_id` integer REFERENCES dining_tables(id);--> statement-breakpoint
CREATE INDEX `bills_table_idx` ON `bills` (`table_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `table_id` integer REFERENCES dining_tables(id);--> statement-breakpoint
CREATE INDEX `orders_table_idx` ON `orders` (`table_id`);--> statement-breakpoint
INSERT INTO `bill_orders` (`bill_id`, `order_id`, `created_at`)
SELECT `id`, `order_id`, `created_at` FROM `bills`
WHERE `id` NOT IN (SELECT `bill_id` FROM `bill_orders`);--> statement-breakpoint
UPDATE `orders`
SET `table_id` = (SELECT `id` FROM `dining_tables` WHERE lower(`dining_tables`.`name`) = lower(`orders`.`table_number`))
WHERE `table_id` IS NULL AND `table_number` IS NOT NULL;