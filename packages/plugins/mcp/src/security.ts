/**
 * Guardrails for a stdio-transport MCP server config — this is the sharp edge of the whole
 * feature: it spawns an arbitrary local subprocess. flowlathe is a single-user local server, so
 * the threat model is narrower than Flowise's (the `MCP_SERVERS_CONFIG_PATH` file is written by
 * the same operator who runs the server — there's no separate, less-trusted "UI user" writing
 * MCP configs the way a Flowise workspace member might). Given that, this ports the checks that
 * still earn their keep even under operator-authored config — a command allowlist (secure
 * default: nothing runs until explicitly opted into) and known code-execution-via-flag patterns
 * — and deliberately drops Flowise's separate env-var-name allowlist and
 * absolute-script-path allowlist, which exist there to guard against a less-trusted config
 * author than flowlathe has.
 */

export class McpConfigError extends Error {}

function parseAllowlist(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>]/;
const COMMAND_CHAINING = /&&|\|\||;;/;

/** Defense in depth: the MCP SDK's stdio transport spawns without a shell, so these characters
 *  aren't directly exploitable through `spawn`'s args array — but a misconfigured or malicious
 *  entry containing them is almost certainly not what the operator intended either way. */
function validateArgsForInjection(args: readonly string[]): void {
  for (const arg of args) {
    if (SHELL_METACHARACTERS.test(arg) || COMMAND_CHAINING.test(arg)) {
      throw new McpConfigError(`argument contains shell metacharacters: "${arg}"`);
    }
  }
}

/** Flags that turn an otherwise-innocuous allowed command into arbitrary code execution —
 *  e.g. an operator allow-lists "npx" to run a specific MCP server package, but "npx -c
 *  <anything>" runs an arbitrary shell command through that same allowed binary. */
const DANGEROUS_FLAGS_BY_COMMAND: Record<string, readonly string[]> = {
  npx: ["-c", "--call", "--shell-auto-fallback", "-y", "--yes", "--node-options"],
  node: [
    "-e",
    "--eval",
    "-p",
    "--print",
    "--inspect",
    "--inspect-brk",
    "--experimental-policy",
    "-r",
    "--require",
    "--loader",
    "--experimental-loader",
    "--import",
    "--env-file",
  ],
  python: ["-c", "-m"],
  python3: ["-c", "-m"],
  docker: [
    "run",
    "build",
    "exec",
    "compose",
    "-v",
    "--volume",
    "--mount",
    "--volumes-from",
    "--privileged",
    "--cap-add",
    "--security-opt",
    "--device",
    "--entrypoint",
    "--network",
    "--pid",
    "--ipc",
    "--env-file",
  ],
};

function validateDangerousFlags(command: string, args: readonly string[]): void {
  const dangerous = DANGEROUS_FLAGS_BY_COMMAND[command] ?? [];
  if (dangerous.length === 0) return;
  const dangerousShortChars = new Set(
    dangerous.filter((f) => /^-[a-zA-Z]$/.test(f)).map((f) => f[1]!.toLowerCase()),
  );

  for (const rawArg of args) {
    const arg = rawArg.toLowerCase().trim();
    for (const flag of dangerous) {
      const lowerFlag = flag.toLowerCase();
      if (arg === lowerFlag || arg.startsWith(`${lowerFlag}=`) || (flag.startsWith("-") && arg.startsWith(`${lowerFlag} `))) {
        throw new McpConfigError(`argument "${rawArg}" (flag "${flag}") is not allowed for command "${command}"`);
      }
    }
    // Combined short flags, e.g. "-yc" = "-y" + "-c".
    if (/^-[a-z]{2,}$/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (dangerousShortChars.has(ch)) {
          throw new McpConfigError(`argument "${rawArg}" contains dangerous flag "-${ch}" for command "${command}"`);
        }
      }
    }
  }
}

function validateEnvValues(env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value.includes("\0")) throw new McpConfigError(`environment variable "${key}" contains a null byte`);
  }
}

/**
 * Validates a stdio MCP server config against the operator's `MCP_ALLOWED_COMMANDS` allowlist
 * (comma-separated; empty/unset means no stdio server can run — a secure default an operator
 * must explicitly opt out of, mirroring how `SPOTIFY_CLIENT_ID` gates the Spotify plugin).
 * Throws `McpConfigError` on any violation.
 */
export function validateStdioServerConfig(
  config: { command: string; args?: readonly string[]; env?: Record<string, string>; cwd?: unknown },
  allowedCommandsCsv: string | undefined,
): void {
  if (config.cwd != null) throw new McpConfigError('a "cwd" is not allowed in an MCP server config');

  const allowed = parseAllowlist(allowedCommandsCsv);
  if (!allowed.has(config.command)) {
    throw new McpConfigError(
      `command "${config.command}" is not in MCP_ALLOWED_COMMANDS (currently: ${[...allowed].join(", ") || "(none)"})`,
    );
  }

  const args = config.args ?? [];
  validateArgsForInjection(args);
  validateDangerousFlags(config.command, args);
  validateEnvValues(config.env);
}
