import { readFile, writeFile } from "node:fs/promises";
import { format } from "@flowlathe/dsl";
import { parseArgs } from "../args.js";
import { defaultFlowFiles } from "../discover.js";

export async function cmdFmt(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const check = flags.has("check");
  const files = positional.length > 0 ? positional : await defaultFlowFiles();

  let exitCode = 0;
  let drifted = 0;
  for (const file of files) {
    const original = await readFile(file, "utf8");
    let formatted: string;
    try {
      formatted = format(original);
    } catch (err) {
      console.error(`${file}: ${(err as Error).message}`);
      exitCode = 1;
      continue;
    }
    if (formatted === original) continue;
    if (check) {
      console.error(`${file}: not formatted (run "flowlathe fmt" to fix)`);
      drifted++;
    } else {
      await writeFile(file, formatted);
      console.log(`formatted ${file}`);
    }
  }
  if (check && drifted > 0) exitCode = 1;
  return exitCode;
}
