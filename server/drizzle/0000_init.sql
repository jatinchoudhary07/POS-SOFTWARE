CREATE TABLE `menu_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `menu_categories_name_unique` ON `menu_categories` (`name`);--> statement-breakpoint
CREATE TABLE `menu_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_paise` integer NOT NULL,
	`is_available` integer DEFAULT true NOT NULL,
	`is_veg` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `menu_categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "menu_items_price_non_negative" CHECK("menu_items"."price_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `menu_items_category_name_unique` ON `menu_items` (`category_id`,`name`);--> statement-breakpoint
CREATE INDEX `menu_items_category_idx` ON `menu_items` (`category_id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`menu_item_id` integer,
	`item_name` text NOT NULL,
	`unit_price_paise` integer NOT NULL,
	`quantity` integer NOT NULL,
	`line_total_paise` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "order_items_quantity_positive" CHECK("order_items"."quantity" > 0),
	CONSTRAINT "order_items_unit_price_non_negative" CHECK("order_items"."unit_price_paise" >= 0),
	CONSTRAINT "order_items_line_total_matches" CHECK("order_items"."line_total_paise" = "order_items"."unit_price_paise" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_number` text NOT NULL,
	`client_request_id` text NOT NULL,
	`order_type` text NOT NULL,
	`table_number` text,
	`notes` text,
	`status` text DEFAULT 'NEW' NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "orders_subtotal_non_negative" CHECK("orders"."subtotal_paise" >= 0),
	CONSTRAINT "orders_type_valid" CHECK("orders"."order_type" IN ('DINE_IN', 'TAKEAWAY')),
	CONSTRAINT "orders_status_valid" CHECK("orders"."status" IN ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_client_request_id_unique` ON `orders` (`client_request_id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_created_at_idx` ON `orders` (`created_at`);