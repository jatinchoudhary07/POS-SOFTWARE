CREATE TABLE `paytm_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_id` integer NOT NULL,
	`merchant_transaction_id` text NOT NULL,
	`provider` text NOT NULL,
	`mid` text NOT NULL,
	`tid` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`state` text DEFAULT 'CREATED' NOT NULL,
	`sale_sent_at` integer,
	`accepted_at` integer,
	`last_result_status` text,
	`last_result_code` text,
	`last_result_message` text,
	`acquirement_id` text,
	`rrn` text,
	`pay_method` text,
	`poll_count` integer DEFAULT 0 NOT NULL,
	`status_error_count` integer DEFAULT 0 NOT NULL,
	`last_polled_at` integer,
	`next_poll_at` integer,
	`deadline_at` integer NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`review_note` text,
	`void_state` text,
	`void_requested_at` integer,
	`void_message` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "paytm_attempts_state_valid" CHECK("paytm_attempts"."state" IN ('CREATED', 'SENDING', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "paytm_attempts_void_state_valid" CHECK("paytm_attempts"."void_state" IS NULL OR "paytm_attempts"."void_state" IN ('REQUESTED', 'VOIDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "paytm_attempts_amount_positive" CHECK("paytm_attempts"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paytm_attempts_payment_unique` ON `paytm_attempts` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `paytm_attempts_txn_unique` ON `paytm_attempts` (`merchant_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `paytm_one_open_per_terminal` ON `paytm_attempts` (`tid`) WHERE state IN ('CREATED', 'SENDING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX `paytm_attempts_poll_idx` ON `paytm_attempts` (`state`,`next_poll_at`);--> statement-breakpoint
CREATE TABLE `paytm_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`kind` text NOT NULL,
	`request` text,
	`response` text,
	`note` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `paytm_attempts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `paytm_events_attempt_idx` ON `paytm_events` (`attempt_id`);