CREATE TABLE `plugin_credentials` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`secret_enc` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
