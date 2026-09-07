import { readFile } from "node:fs/promises";
import { DslError, parse } from "@flowlathe/dsl";
import { parseArgs } from "../args.js";
import { defaultFlowFiles } from "../discover.js";
import { checkGraph } from "../validate.js";

export async function cmdCheck(argv: string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const files = positional.length > 0 ? positional : await defaultFlowFiles();

  let exitCode = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    try {
      const { graph } = parse(text);
      const problems = checkGraph(graph);
      if (problems.length === 0) {
        console.log(`${file}: ok`);
        continue;
      }
      exitCode = 1;
      for (const p of problems) {
        console.error(p.nodeId ? `${file}: node "${p.nodeId}": ${p.message}` : `${file}: ${p.message}`);
      }
    } catch (err) {
      exitCode = 1;
      // DslError's own message already embeds "(line N, column N)" plus a source excerpt.
      console.error(err instanceof DslError ? `${file}: ${err.message}` : `${file}: ${(err as Error).message}`);
    }
  }
  return exitCode;
}
