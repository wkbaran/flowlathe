CREATE TABLE `execution_triggers` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`payload_sha` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payload_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_triggers_external_id_unique` ON `execution_triggers` (`external_id`);--> statement-breakpoint
CREATE TABLE `trigger_cursors` (
	`trigger_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`last_message_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`trigger_id`, `channel_id`),
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`flow_version_id` text NOT NULL,
	`source` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_version_id`) REFERENCES `flow_versions`(`id`) ON UPDATE no action ON DELETE no action
);
