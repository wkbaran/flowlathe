ALTER TABLE `flow_versions` ADD `source_text` text;--> statement-breakpoint
ALTER TABLE `flow_versions` ADD `content_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `flow_versions_flow_id_content_hash_unique` ON `flow_versions` (`flow_id`,`content_hash`);