import type { FlowGraph } from "@flowlathe/core";
import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const nowIso = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const blobs = sqliteTable("blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  byteLen: integer("byte_len").notNull(),
  encoding: text("encoding").notNull(),
  refcount: integer("refcount").notNull().default(0),
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
    createdAt: text("created_at").notNull().default(nowIso()),
  },
  (t) => [unique().on(t.flowId, t.version)],
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

export const executions = sqliteTable("executions", {
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
});

export const branches = sqliteTable("branches", {
  id: text("id").primaryKey(),
  executionId: text("execution_id")
    .notNull()
    .references(() => executions.id),
  parentBranchId: text("parent_branch_id"),
  forkedFromSnapshotId: text("forked_from_snapshot_id"),
  label: text("label"),
  createdAt: text("created_at").notNull().default(nowIso()),
});

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

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  role: text("role")
    .notNull()
    .$type<"system" | "user" | "assistant" | "thinking" | "tool">(),
  contentSha: text("content_sha")
    .notNull()
    .references(() => blobs.sha256),
  tokenCount: integer("token_count"),
  metaJson: text("meta_json", { mode: "json" }),
});

export const contexts = sqliteTable("contexts", {
  id: text("id").primaryKey(),
  executionId: text("execution_id")
    .notNull()
    .references(() => executions.id),
  parentContextId: text("parent_context_id"),
  transformCallId: text("transform_call_id"),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(nowIso()),
});

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
  (t) => [primaryKey({ columns: [t.contextId, t.ord] })],
);

export const contextTransformCalls = sqliteTable("context_transform_calls", {
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
});

export const responses = sqliteTable("responses", {
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
});

export const toolCalls = sqliteTable("tool_calls", {
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
});

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
  },
  (t) => [primaryKey({ columns: [t.flowVersionId, t.name] })],
);

export const stateWrites = sqliteTable("state_writes", {
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
});

export const stateReads = sqliteTable("state_reads", {
  id: text("id").primaryKey(),
  branchId: text("branch_id")
    .notNull()
    .references(() => branches.id),
  stepId: text("step_id").references(() => steps.id),
  entry: text("entry").notNull(),
  seqSeen: integer("seq_seen").notNull(),
});

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
  (t) => [unique().on(t.executionId, t.seq)],
);
