import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** `FLOWLATHE_FLOWS_DIR` (default `./flows`) — the same default S3's file-backed store uses. A
 *  command given no explicit files operates on every `*.flow` file directly inside it (flat,
 *  non-recursive — matches the file store's own layout, PLAN-FLOW-DSL.md §4.1). */
export function flowsDir(): string {
  return process.env["FLOWLATHE_FLOWS_DIR"] ?? "./flows";
}

export async function defaultFlowFiles(): Promise<string[]> {
  const dir = flowsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`no files given and "${dir}" does not exist (set FLOWLATHE_FLOWS_DIR or pass files explicitly)`);
  }
  return entries
    .filter((name) => name.endsWith(".flow"))
    .sort()
    .map((name) => join(dir, name));
}
