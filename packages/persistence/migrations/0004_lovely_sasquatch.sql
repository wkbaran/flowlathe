CREATE TABLE `flow_pins` (
	`flow_id` text NOT NULL,
	`channel` text NOT NULL,
	`flow_version_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`flow_id`, `channel`),
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_version_id`) REFERENCES `flow_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `flow_versions` ADD `label` text;--> statement-breakpoint
ALTER TABLE `flow_versions` ADD `message` text;--> statement-breakpoint
ALTER TABLE `flow_versions` ADD `parent_version_id` text;