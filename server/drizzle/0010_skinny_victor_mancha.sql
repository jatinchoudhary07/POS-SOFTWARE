CREATE TABLE `credit_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credit_sale_id` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	`method` text NOT NULL,
	`provider_reference` text,
	`note` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`credit_sale_id`) REFERENCES `credit_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "credit_receipts_amount_positive" CHECK("credit_receipts"."amount_paise" > 0),
	CONSTRAINT "credit_receipts_method_valid" CHECK("credit_receipts"."method" IN ('CASH', 'UPI_MANUAL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_receipts_idempotency_unique` ON `credit_receipts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `credit_receipts_sale_idx` ON `credit_receipts` (`credit_sale_id`);--> statement-breakpoint
CREATE TABLE `credit_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`bill_id` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "credit_sales_amount_positive" CHECK("credit_sales"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_sales_payment_unique` ON `credit_sales` (`payment_id`);--> statement-breakpoint
CREATE INDEX `credit_sales_customer_idx` ON `credit_sales` (`customer_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "customers_phone_valid" CHECK(length("customers"."phone") = 10 AND "customers"."phone" NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payments` (
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
	CONSTRAINT "payments_method_valid" CHECK("__new_payments"."method" IN ('CASH', 'UPI_MANUAL', 'TERMINAL', 'CREDIT')),
	CONSTRAINT "payments_status_valid" CHECK("__new_payments"."status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REFUNDED')),
	CONSTRAINT "payments_amount_positive" CHECK("__new_payments"."amount_paise" > 0),
	CONSTRAINT "payments_cash_fields" CHECK(("__new_payments"."tendered_paise" IS NULL AND "__new_payments"."change_paise" IS NULL) OR ("__new_payments"."tendered_paise" >= "__new_payments"."amount_paise" AND "__new_payments"."change_paise" = "__new_payments"."tendered_paise" - "__new_payments"."amount_paise"))
);
--> statement-breakpoint
INSERT INTO `__new_payments`("id", "order_id", "bill_id", "method", "status", "amount_paise", "tendered_paise", "change_paise", "idempotency_key", "provider", "provider_reference", "failure_reason", "note", "completed_at", "refunded_at", "refund_reason", "created_at", "updated_at") SELECT "id", "order_id", "bill_id", "method", "status", "amount_paise", "tendered_paise", "change_paise", "idempotency_key", "provider", "provider_reference", "failure_reason", "note", "completed_at", "refunded_at", "refund_reason", "created_at", "updated_at" FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_success_per_order` ON `payments` (`order_id`) WHERE status = 'SUCCEEDED';--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_open_attempt_per_order` ON `payments` (`order_id`) WHERE status IN ('PENDING', 'UNKNOWN');--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `payments_completed_at_idx` ON `payments` (`completed_at`);