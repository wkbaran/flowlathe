import { randomUUID } from "node:crypto";
import type { FlowGraph } from "@flowlathe/core";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { flowVersions, flows } from "./schema.js";

export interface FlowSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowWithGraph extends FlowSummary {
  version: number;
  graph: FlowGraph;
}

export function createFlow(db: Db, name: string, graph: FlowGraph): FlowWithGraph {
  const id = randomUUID();
  db.insert(flows).values({ id, name }).run();
  const version = 1;
  db.insert(flowVersions)
    .values({ id: randomUUID(), flowId: id, version, graphJson: graph })
    .run();
  const row = mustGetFlowRow(db, id);
  return { ...row, version, graph };
}

export function listFlows(db: Db): FlowSummary[] {
  return db
    .select({ id: flows.id, name: flows.name, createdAt: flows.createdAt, updatedAt: flows.updatedAt })
    .from(flows)
    .orderBy(desc(flows.updatedAt))
    .all();
}

export function getFlow(db: Db, id: string): FlowWithGraph | undefined {
  const flow = db.select().from(flows).where(eq(flows.id, id)).get();
  if (!flow) return undefined;
  const latest = db
    .select()
    .from(flowVersions)
    .where(eq(flowVersions.flowId, id))
    .orderBy(desc(flowVersions.version))
    .get();
  if (!latest) return undefined;
  return { ...flow, version: latest.version, graph: latest.graphJson };
}

export function saveFlowVersion(db: Db, flowId: string, graph: FlowGraph): FlowWithGraph {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get();
  if (!flow) throw new Error(`flow not found: ${flowId}`);
  const latest = db
    .select({ version: flowVersions.version })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.version))
    .get();
  const version = (latest?.version ?? 0) + 1;
  db.insert(flowVersions)
    .values({ id: randomUUID(), flowId, version, graphJson: graph })
    .run();
  db.update(flows)
    .set({ updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(flows.id, flowId))
    .run();
  const row = mustGetFlowRow(db, flowId);
  return { ...row, version, graph };
}

function mustGetFlowRow(db: Db, id: string): FlowSummary {
  const row = db.select().from(flows).where(eq(flows.id, id)).get();
  if (!row) throw new Error(`flow not found: ${id}`);
  return row;
}
