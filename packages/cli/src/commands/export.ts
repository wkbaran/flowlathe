import { readFile, writeFile } from "node:fs/promises";
import { compileGraph } from "@flowlathe/compiler";
import { parse } from "@flowlathe/dsl";
import { parseArgs } from "../args.js";
import { resolveProviders } from "../providers.js";
import { checkGraph } from "../validate.js";

export async function cmdExport(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["out"]);
  const file = positional[0];
  if (!file) {
    console.error("usage: flowlathe export <file> [--out <path>]");
    return 1;
  }

  const text = await readFile(file, "utf8");
  const { graph } = parse(text);
  const problems = checkGraph(graph);
  if (problems.length > 0) {
    for (const p of problems) console.error(p.nodeId ? `node "${p.nodeId}": ${p.message}` : p.message);
    return 1;
  }

  const providers = resolveProviders(graph);
  const script = compileGraph(graph, { providers });

  const out = options.get("out");
  if (out) {
    await writeFile(out, script);
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(script);
  }
  return 0;
}
