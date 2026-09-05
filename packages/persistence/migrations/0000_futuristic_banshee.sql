CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`byte_len` integer NOT NULL,
	`encoding` text NOT NULL,
	`refcount` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`parent_branch_id` text,
	`forked_from_snapshot_id` text,
	`label` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `context_messages` (
	`context_id` text NOT NULL,
	`ord` integer NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`context_id`, `ord`),
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `context_transform_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`source_context_id` text NOT NULL,
	`result_context_id` text NOT NULL,
	`transform_kind` text NOT NULL,
	`params_json` text,
	`model_id` text,
	`response_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`source_context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`parent_context_id` text,
	`transform_call_id` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_version_id` text NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`root_branch_id` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	`error_json` text,
	FOREIGN KEY (`flow_version_id`) REFERENCES `flow_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `flow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`version` integer NOT NULL,
	`graph_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flow_versions_flow_id_version_unique` ON `flow_versions` (`flow_id`,`version`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`content_sha` text NOT NULL,
	`token_count` integer,
	`meta_json` text,
	FOREIGN KEY (`content_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_name` text NOT NULL,
	`context_window` integer,
	`defaults_json` text,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`secret_enc` text,
	`max_parallel` integer DEFAULT 1 NOT NULL,
	`rpm` integer,
	`tpm` integer,
	`swap_cost_ms` integer,
	`resident_models` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `responses` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`step_id` text,
	`node_id` text NOT NULL,
	`model_id` text,
	`request_context_id` text,
	`rendered_prompt_sha` text,
	`thinking_sha` text,
	`content_sha` text,
	`structured_json` text,
	`finish_reason` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`latency_ms` integer,
	`queue_wait_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`error_json` text,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rendered_prompt_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thinking_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`branch_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_execution_id_seq_unique` ON `run_events` (`execution_id`,`seq`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`parent_snapshot_id` text,
	`payload_json` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_branch_idx` ON `snapshots` (`branch_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `state_decls` (
	`flow_version_id` text NOT NULL,
	`name` text NOT NULL,
	`type_json` text NOT NULL,
	`merge` text NOT NULL,
	`initial_json` text,
	PRIMARY KEY(`flow_version_id`, `name`),
	FOREIGN KEY (`flow_version_id`) REFERENCES `flow_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`step_id` text,
	`entry` text NOT NULL,
	`seq_seen` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`step_id` text,
	`entry` text NOT NULL,
	`value_sha` text NOT NULL,
	`merge_applied` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`value_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`activation_key` text NOT NULL,
	`node_id` text NOT NULL,
	`scope_json` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_branch_id_step_index_unique` ON `steps` (`branch_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`response_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`args_json` text NOT NULL,
	`result_sha` text,
	`error_json` text,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`response_id`) REFERENCES `responses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
