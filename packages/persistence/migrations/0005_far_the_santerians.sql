DROP INDEX `flow_versions_flow_id_content_hash_unique`;--> statement-breakpoint
CREATE INDEX `flow_versions_content_idx` ON `flow_versions` (`flow_id`,`content_hash`);