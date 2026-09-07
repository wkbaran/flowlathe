import { cmdCheck } from "./commands/check.js";
import { cmdExport } from "./commands/export.js";
import { cmdFlows } from "./commands/flows.js";
import { cmdFmt } from "./commands/fmt.js";
import { cmdRun } from "./commands/run.js";

const USAGE = `usage: flowlathe <command> [args]

commands:
  fmt [files...] [--check]          canonicalize .flow files in place
  check [files...]                  parse + validate .flow files
  export <file> [--out <path>]      emit a standalone TS script
  run <file>                        headless interpreter run, streaming RunEvent JSON
  flows export [--dir <dir>]        every flow_versions row -> flows/<slug>.flow
  flows import <file> [--db <path>] a .flow file -> a new flow_versions row

files default to every *.flow file in FLOWLATHE_FLOWS_DIR (default ./flows) when omitted.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "fmt":
      return cmdFmt(rest);
    case "check":
      return cmdCheck(rest);
    case "export":
      return cmdExport(rest);
    case "run":
      return cmdRun(rest);
    case "flows":
      return cmdFlows(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
