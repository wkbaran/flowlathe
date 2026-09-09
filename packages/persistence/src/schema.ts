import type { FlowGraph } from "@flowlathe/core";
import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const nowIso = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const blobs = sqliteTable("blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  byteLen: integer("byte_len").notNull(),
  encoding: text("encoding").notNull(),
});

export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(nowIso()),
  updatedAt: text("updated_at").notNull().default(nowIso()),
});

export const flowVersions = sqliteTable(
  "flow_versions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    version: integer("version").notNull(),
    graphJson: text("graph_json", { mode: "json" }).$type<FlowGraph>().notNull(),
    /** The canonical (`@flowlathe/dsl` `format`-ed) `.flow` text this version was snapshotted
     *  from — null for a version saved before PLAN-FLOW-DSL.md S3, or one saved through a path
     *  that never had DSL text (there is none once flows are always file-backed). What makes an
     *  old execution's flow viewable *as text* even after the file changed on disk or was
     *  deleted — see PLAN-FLOW-DSL.md §4.2. */
    sourceText: text("source_text"),
    /** sha256 of `sourceText` when given, else of `canonicalGraphJson(graph)`
     *  (PLAN-FLOW-VERSIONING.md §4.1). Deliberately NOT unique (see the index below): dedup
     *  against it is enforced by `saveFlowVersion`'s own SELECT-before-insert, not by a DB
     *  constraint — because a restore (`opts.force`) must be able to insert a genuinely new row
     *  whose content duplicates an old one (§3: "Restore creates a new version"; a restored-to
     *  graph identical to some old revision is a real, expected case, not a bug). */
    contentHash: text("content_hash"),
    /** NULL = an unnamed (autosaved, GC-able) revision. Non-null = a named version a human
     *  labeled — never collected (PLAN-FLOW-VERSIONING.md §3). */
    label: text("label"),
    message: text("message"),
    /** The version this one was saved *from* — usually the immediately preceding version (a
     *  normal edit-and-save), but NOT always: restoring an old version and continuing from it
     *  points here at the restored version, not at whatever was HEAD a moment before. This is
     *  what makes history a tree rather than a flat list. No `.references()` — self-referential,
     *  same convention as `branches.parentBranchId`/`snapshots.parentSnapshotId` above. */
    parentVersionId: text("parent_version_id"),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [unique().on(t.flowId, t.version), index("flow_versions_content_idx").on(t.flowId, t.contentHash)],
);

/** A named pointer some consumer follows: a trigger, a scheduled run, an exported deployment.
 *  Points at one revision, changes only by explicit action — never re-resolved to HEAD later
 *  (PLAN-FLOW-VERSIONING.md §3, §6). Discord triggers currently pin inline via
 *  `triggers.flowVersionId` rather than through this table (that predates this table and already
 *  satisfies "never follow HEAD"); this table backs the generic `channel` concept (starting with
 *  `"default"`) for consumers that don't have their own row to pin from. */
export const flowPins = sqliteTable(
  "flow_pins",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    channel: text("channel").notNull(),
    flowVersionId: text("flow_version_id")
      .notNull()
      .references(() => flowVersions.id),
    updatedAt: text("updated_at").notNull().default(nowIso()),
  },
  (t) => [primaryKey({ columns: [t.flowId, t.channel] }), index("flow_pins_flow_version_idx").on(t.flowVersionId)],
);

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().$type<"mock" | "ollama" | "openai-compat">(),
  baseUrl: text("base_url"),
  secretEnc: text("secret_enc"),
  maxParallel: integer("max_parallel").notNull().default(1),
  rpm: integer("rpm"),
  tpm: integer("tpm"),
  swapCostMs: integer("swap_cost_ms"),
  residentModels: integer("resident_models").notNull().default(1),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id),
  modelName: text("model_name").notNull(),
  contextWindow: integer("context_window"),
  defaultsJson: text("defaults_json", { mode: "json" }),
});

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    flowVersionId: text("flow_version_id")
      .notNull()
      .references(() => flowVersions.id),
    status: text("status")
      .notNull()
      .$type<"running" | "awaiting_input" | "finished" | "failed" | "cancelled">(),
    mode: text("mode").notNull().$type<"run" | "step">(),
    rootBranchId: text("root_branch_id"),
    startedAt: text("started_at").notNull().default(nowIso()),
    endedAt: text("ended_at"),
    errorJson: text("error_json", { mode: "json" }),
  },
  (t) => [index("executions_flow_version_idx").on(t.flowVersionId)],
);

export const branches = sqliteTable(
  "branches",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id),
    parentBranchId: text("parent_branch_id"),
    forkedFromSnapshotId: text("forked_from_snapshot_id"),
    label: text("label"),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [index("branches_execution_idx").on(t.executionId)],
);

export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    stepIndex: integer("step_index").notNull(),
    activationKey: text("activation_key").notNull(),
    nodeId: text("node_id").notNull(),
    scopeJson: text("scope_json", { mode: "json" }).notNull(),
    status: text("status")
      .notNull()
      .$type<"waiting" | "ready" | "running" | "suspended" | "done" | "skipped" | "failed" | "cancelled">(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (t) => [unique().on(t.branchId, t.stepIndex)],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    stepIndex: integer("step_index").notNull(),
    parentSnapshotId: text("parent_snapshot_id"),
    payloadJson: text("payload_json", { mode: "json" }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [index("snapshots_branch_idx").on(t.branchId, t.stepIndex)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    role: text("role")
      .notNull()
      .$type<"system" | "user" | "assistant" | "thinking" | "tool">(),
    contentSha: text("content_sha")
      .notNull()
      .references(() => blobs.sha256),
    tokenCount: integer("token_count"),
    metaJson: text("meta_json", { mode: "json" }),
  },
  (t) => [index("messages_content_sha_idx").on(t.contentSha)],
);

export const contexts = sqliteTable(
  "contexts",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id),
    parentContextId: text("parent_context_id"),
    transformCallId: text("transform_call_id"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [index("contexts_execution_idx").on(t.executionId)],
);

export const contextMessages = sqliteTable(
  "context_messages",
  {
    contextId: text("context_id")
      .notNull()
      .references(() => contexts.id),
    ord: integer("ord").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
  },
  (t) => [primaryKey({ columns: [t.contextId, t.ord] }), index("context_messages_message_idx").on(t.messageId)],
);

export const contextTransformCalls = sqliteTable(
  "context_transform_calls",
  {
    id: text("id").primaryKey(),
    sourceContextId: text("source_context_id")
      .notNull()
      .references(() => contexts.id),
    resultContextId: text("result_context_id")
      .notNull()
      .references(() => contexts.id),
    transformKind: text("transform_kind").notNull(),
    paramsJson: text("params_json", { mode: "json" }),
    modelId: text("model_id").references(() => models.id),
    responseId: text("response_id"),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [
    index("context_transform_calls_source_idx").on(t.sourceContextId),
    index("context_transform_calls_result_idx").on(t.resultContextId),
  ],
);

export const responses = sqliteTable(
  "responses",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    stepId: text("step_id").references(() => steps.id),
    nodeId: text("node_id").notNull(),
    modelId: text("model_id").references(() => models.id),
    requestContextId: text("request_context_id").references(() => contexts.id),
    renderedPromptSha: text("rendered_prompt_sha").references(() => blobs.sha256),
    thinkingSha: text("thinking_sha").references(() => blobs.sha256),
    contentSha: text("content_sha").references(() => blobs.sha256),
    structuredJson: text("structured_json", { mode: "json" }),
    finishReason: text("finish_reason"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms"),
    queueWaitMs: integer("queue_wait_ms"),
    createdAt: text("created_at").notNull().default(nowIso()),
    errorJson: text("error_json", { mode: "json" }),
  },
  (t) => [
    index("responses_execution_idx").on(t.executionId),
    index("responses_branch_idx").on(t.branchId),
    index("responses_step_idx").on(t.stepId),
    index("responses_request_context_idx").on(t.requestContextId),
    index("responses_rendered_prompt_sha_idx").on(t.renderedPromptSha),
    index("responses_thinking_sha_idx").on(t.thinkingSha),
    index("responses_content_sha_idx").on(t.contentSha),
  ],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    responseId: text("response_id")
      .notNull()
      .references(() => responses.id),
    toolName: text("tool_name").notNull(),
    argsJson: text("args_json", { mode: "json" }).notNull(),
    resultSha: text("result_sha").references(() => blobs.sha256),
    errorJson: text("error_json", { mode: "json" }),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (t) => [index("tool_calls_result_sha_idx").on(t.resultSha)],
);

export const stateDecls = sqliteTable(
  "state_decls",
  {
    flowVersionId: text("flow_version_id")
      .notNull()
      .references(() => flowVersions.id),
    name: text("name").notNull(),
    typeJson: text("type_json", { mode: "json" }).notNull(),
    merge: text("merge")
      .notNull()
      .$type<"replace" | "append" | "numeric-add" | "set-union" | "error-on-conflict">(),
    initialJson: text("initial_json", { mode: "json" }),
    /** PLAN-STATE-FILES.md: only meaningful when `typeJson` is `"file"`. Nullable — every entry
     *  declared before this plan has none of these three columns set. */
    fileMode: text("file_mode").$type<"read-only" | "read-write">(),
    versioned: integer("versioned", { mode: "boolean" }),
    filePath: text("file_path"),
  },
  (t) => [primaryKey({ columns: [t.flowVersionId, t.name] })],
);

export const stateWrites = sqliteTable(
  "state_writes",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    stepId: text("step_id").references(() => steps.id),
    entry: text("entry").notNull(),
    valueSha: text("value_sha")
      .notNull()
      .references(() => blobs.sha256),
    mergeApplied: text("merge_applied").notNull(),
    seq: integer("seq").notNull(),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [
    index("state_writes_branch_idx").on(t.branchId),
    index("state_writes_step_idx").on(t.stepId),
    index("state_writes_value_sha_idx").on(t.valueSha),
  ],
);

export const stateReads = sqliteTable(
  "state_reads",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id),
    stepId: text("step_id").references(() => steps.id),
    entry: text("entry").notNull(),
    seqSeen: integer("seq_seen").notNull(),
  },
  (t) => [index("state_reads_branch_idx").on(t.branchId), index("state_reads_step_idx").on(t.stepId)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id),
    branchId: text("branch_id").references(() => branches.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json", { mode: "json" }).notNull(),
    at: text("at").notNull().default(nowIso()),
  },
  (t) => [unique().on(t.executionId, t.seq), index("run_events_branch_idx").on(t.branchId)],
);

/** One row per plugin (e.g. "spotify"), holding whatever that plugin needs to authenticate —
 *  typically a refresh token — as a single opaque encrypted blob. Generic across plugins rather
 *  than a spotify-specific table: the shape inside secretEnc is the plugin's own business, this
 *  table just gives every plugin the same encrypted-at-rest storage providers.secretEnc already
 *  has. */
export const pluginCredentials = sqliteTable("plugin_credentials", {
  pluginId: text("plugin_id").primaryKey(),
  secretEnc: text("secret_enc").notNull(),
  updatedAt: text("updated_at").notNull().default(nowIso()),
});

/** A trigger runs a *pinned* flow version, never HEAD — editing a flow on the canvas must not
 *  silently change what a live Discord bot does; re-pinning is an explicit action. */
export const triggers = sqliteTable(
  "triggers",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    flowVersionId: text("flow_version_id")
      .notNull()
      .references(() => flowVersions.id),
    source: text("source").notNull().$type<"discord">(),
    configJson: text("config_json", { mode: "json" }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [index("triggers_flow_version_idx").on(t.flowVersionId)],
);

/** Provenance ("why did this run?") plus the dedupe mechanism: the `externalId` unique
 *  constraint IS the claim a redelivered Discord message id can't pass twice, surviving a
 *  server restart (unlike an in-memory set). */
export const executionTriggers = sqliteTable(
  "execution_triggers",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => executions.id),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    payloadSha: text("payload_sha")
      .notNull()
      .references(() => blobs.sha256),
    at: text("at").notNull().default(nowIso()),
  },
  (t) => [unique().on(t.externalId), index("execution_triggers_payload_sha_idx").on(t.payloadSha)],
);

/** Per-(trigger, channel) cursor for post-reconnect recovery scans — absent means "never
 *  connected before," so a brand-new trigger doesn't replay a channel's backlog. */
export const triggerCursors = sqliteTable(
  "trigger_cursors",
  {
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id),
    channelId: text("channel_id").notNull(),
    lastMessageId: text("last_message_id").notNull(),
    updatedAt: text("updated_at").notNull().default(nowIso()),
  },
  (t) => [primaryKey({ columns: [t.triggerId, t.channelId] })],
);
