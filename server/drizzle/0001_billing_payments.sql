CREATE TABLE `bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`subtotal_paise` integer NOT NULL,
	`discount_type` text DEFAULT 'NONE' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`discount_reason` text,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`taxable_paise` integer NOT NULL,
	`tax_paise` integer NOT NULL,
	`tax_lines` text NOT NULL,
	`round_off_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "bills_status_valid" CHECK("bills"."status" IN ('OPEN', 'PAID', 'REFUNDED')),
	CONSTRAINT "bills_discount_type_valid" CHECK("bills"."discount_type" IN ('NONE', 'PERCENT', 'AMOUNT')),
	CONSTRAINT "bills_discount_range" CHECK("bills"."discount_paise" >= 0 AND "bills"."discount_paise" <= "bills"."subtotal_paise"),
	CONSTRAINT "bills_taxable_matches" CHECK("bills"."taxable_paise" = "bills"."subtotal_paise" - "bills"."discount_paise"),
	CONSTRAINT "bills_tax_non_negative" CHECK("bills"."tax_paise" >= 0),
	CONSTRAINT "bills_total_matches" CHECK("bills"."total_paise" = "bills"."taxable_paise" + "bills"."tax_paise" + "bills"."round_off_paise"),
	CONSTRAINT "bills_total_non_negative" CHECK("bills"."total_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_order_unique` ON `bills` (`order_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`bill_id` integer NOT NULL,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`tendered_paise` integer,
	`change_paise` integer,
	`idempotency_key` text NOT NULL,
	`provider` text NOT NULL,
	`provider_reference` text,
	`failure_reason` text,
	`note` text,
	`completed_at` integer,
	`refunded_at` integer,
	`refund_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payments_method_valid" CHECK("payments"."method" IN ('CASH', 'UPI_MANUAL', 'TERMINAL')),
	CONSTRAINT "payments_status_valid" CHECK("payments"."status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REFUNDED')),
	CONSTRAINT "payments_amount_positive" CHECK("payments"."amount_paise" > 0),
	CONSTRAINT "payments_cash_fields" CHECK(("payments"."tendered_paise" IS NULL AND "payments"."change_paise" IS NULL) OR ("payments"."tendered_paise" >= "payments"."amount_paise" AND "payments"."change_paise" = "payments"."tendered_paise" - "payments"."amount_paise"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_success_per_order` ON `payments` (`order_id`) WHERE status = 'SUCCEEDED';--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_open_attempt_per_order` ON `payments` (`order_id`) WHERE status IN ('PENDING', 'UNKNOWN');--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `payments_completed_at_idx` ON `payments` (`completed_at`);--> statement-breakpoint
CREATE TABLE `restaurant_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`restaurant_name` text NOT NULL,
	`address_line` text,
	`phone` text,
	`tax_id` text,
	`receipt_footer` text,
	`round_to_rupee` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "restaurant_settings_single_row" CHECK("restaurant_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`rate_bps` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "tax_rates_rate_range" CHECK("tax_rates"."rate_bps" >= 0 AND "tax_rates"."rate_bps" <= 10000)
);
