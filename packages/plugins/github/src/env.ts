import type { ToolRegistration } from "@flowlathe/core";
import { GithubClient } from "./client.js";
import { createGithubToolset } from "./tools.js";

export interface GithubConfig {
  token: string;
  /** Default "https://api.github.com"; overridable for GitHub Enterprise and for tests. */
  apiBaseUrl: string;
  /** Lowercased "owner/name" — GitHub owners and repo names are case-insensitive, so the
   *  allowlist check in tools.ts must compare case-insensitively too. */
  allowedRepos: ReadonlySet<string>;
  mode: "ro" | "rw";
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

/** `GITHUB_MODE` anything other than exactly "rw" — unset, empty, or a typo — is "ro". Fail
 *  closed rather than silently granting write access on a misspelling. */
function modeFromEnv(env: NodeJS.ProcessEnv): "ro" | "rw" {
  const raw = env["GITHUB_MODE"];
  if (raw === undefined || raw === "" || raw === "ro") return "ro";
  if (raw === "rw") return "rw";
  console.warn(`[github] unrecognized GITHUB_MODE ${JSON.stringify(raw)}; falling back to "ro"`);
  return "ro";
}

/** `undefined` — zero registrations — exactly when `GITHUB_TOKEN` is unset or empty. An empty
 *  `GITHUB_ALLOWED_REPOS` does *not* suppress registration; it produces an `unavailableReason`
 *  (see tools.ts), which is what lets the workflow-dependency banner say something useful
 *  instead of the toolset silently not existing. */
export function githubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GithubConfig | undefined {
  const token = env["GITHUB_TOKEN"];
  if (!token) return undefined;
  const csv = env["GITHUB_ALLOWED_REPOS"];
  const allowedRepos = new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    token,
    apiBaseUrl: (env["GITHUB_API_BASE_URL"] ?? DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    allowedRepos,
    mode: modeFromEnv(env),
  };
}

export function githubClientFromEnv(env: NodeJS.ProcessEnv = process.env): GithubClient | undefined {
  const config = githubConfigFromEnv(env);
  if (!config) return undefined;
  return new GithubClient({ token: config.token, apiBaseUrl: config.apiBaseUrl });
}

/** Named export a compiled, exported script calls to reconstruct this toolset from environment
 *  alone — see `ToolRegistration.standalone` (attached in `createGithubToolset`) and
 *  PLAN-GITHUB.md L7. Used the same way by the live server (`packages/server/src/index.ts`). */
export function githubToolsetFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRegistration[] {
  const config = githubConfigFromEnv(env);
  if (!config) return [];
  const client = new GithubClient({ token: config.token, apiBaseUrl: config.apiBaseUrl });
  return createGithubToolset(client, { allowedRepos: config.allowedRepos, mode: config.mode });
}
