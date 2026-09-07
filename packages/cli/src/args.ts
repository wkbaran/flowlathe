/** Deliberately hand-rolled: the repo has no arg-parsing library dependency anywhere, and this
 *  CLI's whole surface (§5's five commands) needs at most one flag + one option per command. */
export interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

export function parseArgs(argv: string[], optionNames: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (optionNames.includes(name)) {
        const value = argv[++i];
        if (value === undefined) throw new Error(`--${name} requires a value`);
        options.set(name, value);
      } else {
        flags.add(name);
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags, options };
}
