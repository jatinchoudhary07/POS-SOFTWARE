CREATE TABLE `merged_requests` (
	`client_request_id` text PRIMARY KEY NOT NULL,
	`order_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `order_items` ADD `kitchen_done` integer DEFAULT false NOT NULL;