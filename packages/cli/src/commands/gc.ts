import {
  gcAllExecutions,
  gcExecutions,
  openDb,
  runMigrations,
  withTransaction,
  type Db,
  type ExecutionGcOptions,
  type ExecutionGcResult,
} from "@flowlathe/persistence";
import { parseArgs } from "../args.js";

class DryRunAbort extends Error {}

/** Runs `fn` inside a real transaction, then rolls it back — the sentinel-throw is deliberately
 *  ugly rather than a parallel counting path that can drift from the real delete logic.
 *  `withTransaction` is re-entrant (falls back to SAVEPOINT), so this works even though
 *  `deleteExecution` opens its own nested transaction per execution. */
function withDryRun<T>(db: Db, fn: () => T): T {
  let result!: T;
  try {
    withTransaction(db, () => {
      result = fn();
      throw new DryRunAbort();
    });
  } catch (err) {
    if (!(err instanceof DryRunAbort)) throw err;
  }
  return result;
}

function summarize(results: ExecutionGcResult[]) {
  return results.reduce(
    (acc, r) => ({ executions: acc.executions + r.executions, blobs: acc.blobs + r.blobs, bytes: acc.bytes + r.bytes }),
    { executions: 0, blobs: 0, bytes: 0 },
  );
}

export async function cmdGc(argv: string[]): Promise<number> {
  const { flags, options } = parseArgs(argv, ["db", "flow", "older-than-days", "abandoned-after-days"]);
  const dbPath = options.get("db") ?? requireDbPath();
  if (!dbPath) return 1;

  const dryRun = flags.has("dry-run");
  const vacuum = flags.has("vacuum");
  if (dryRun && vacuum) {
    console.error("--vacuum cannot be combined with --dry-run");
    return 1;
  }
  const flowId = options.get("flow");
  const gcOptions: ExecutionGcOptions = {};
  if (options.has("older-than-days")) gcOptions.olderThanDays = Number(options.get("older-than-days"));
  if (options.has("abandoned-after-days")) gcOptions.abandonedAfterDays = Number(options.get("abandoned-after-days"));

  const opened = openDb(dbPath);
  try {
    runMigrations(opened);

    const run = (): ExecutionGcResult[] =>
      flowId ? [gcExecutions(opened.db, flowId, gcOptions)] : gcAllExecutions(opened.db, gcOptions);

    const results = dryRun ? withDryRun(opened.db, run) : run();
    const totals = summarize(results);
    const mb = (totals.bytes / 1024 / 1024).toFixed(2);
    console.log(
      `${dryRun ? "[dry-run] would collect" : "collected"} ${totals.executions} execution(s), ${totals.blobs} blob(s), ${mb} MB`,
    );

    if (vacuum) {
      opened.sqlite.exec("VACUUM");
      console.log("vacuumed");
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
