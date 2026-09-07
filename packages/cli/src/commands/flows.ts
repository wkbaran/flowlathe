import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uniqueSlug } from "@flowlathe/core";
import { print, parse, type FlowFile } from "@flowlathe/dsl";
import { createFlow, getFlow, listFlows, openDb, runMigrations, saveFlowVersion } from "@flowlathe/persistence";
import { parseArgs } from "../args.js";
import { flowsDir } from "../discover.js";

/** PLAN-FLOW-DSL.md §4.4: a one-shot, non-destructive migration between the pre-S3 DB-backed
 *  `flow_versions` table and `.flow` files on disk. Existing rows are never touched — `export`
 *  only reads, `import` only ever adds a new version. */
export async function cmdFlows(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "export") return cmdFlowsExport(rest);
  if (sub === "import") return cmdFlowsImport(rest);
  console.error(`usage: flowlathe flows export [--dir <dir>]\n       flowlathe flows import <file> [--db <path>]`);
  return 1;
}

async function cmdFlowsExport(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, ["dir", "db"]);
  const dir = options.get("dir") ?? flowsDir();
  const dbPath = options.get("db") ?? requireDbPath();
  if (!dbPath) return 1;

  const opened = openDb(dbPath);
  try {
    runMigrations(opened);
    const summaries = listFlows(opened.db);
    await mkdir(dir, { recursive: true });
    const taken = new Set<string>();
    for (const summary of summaries) {
      const flow = getFlow(opened.db, summary.id);
      if (!flow) continue;
      const slug = uniqueSlug(flow.name, taken);
      taken.add(slug);
      const file: FlowFile = { name: flow.name, graph: flow.graph, comments: {} };
      const path = join(dir, `${slug}.flow`);
      await writeFile(path, print(file));
      console.log(`wrote ${path}`);
    }
    return 0;
  } finally {
    opened.close();
  }
}

async function cmdFlowsImport(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["db"]);
  const file = positional[0];
  if (!file) {
    console.error("usage: flowlathe flows import <file> [--db <path>]");
    return 1;
  }
  const dbPath = options.get("db") ?? requireDbPath();
  if (!dbPath) return 1;

  const text = await readFile(file, "utf8");
  const { name, graph } = parse(text);

  const opened = openDb(dbPath);
  try {
    runMigrations(opened);
    const existing = listFlows(opened.db).find((f) => f.name === name);
    if (existing) {
      const saved = saveFlowVersion(opened.db, existing.id, graph);
      console.log(`saved "${name}" as version ${saved.version} (flow ${existing.id})`);
    } else {
      const created = createFlow(opened.db, name, graph);
      console.log(`created "${name}" (flow ${created.id})`);
    }
    return 0;
  } finally {
    opened.close();
  }
}

function requireDbPath(): string | undefined {
  const path = process.env["FLOWLATHE_DB_PATH"];
  if (!path) {
    console.error("no --db given and FLOWLATHE_DB_PATH is not set");
    return undefined;
  }
  return path;
}
