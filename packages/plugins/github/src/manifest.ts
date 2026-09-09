import type { PluginManifest } from "@flowlathe/core";

/** No `connect` field — there is no OAuth dance. Auth is a manually-set `GITHUB_TOKEN` and
 *  nothing else (PLAN-GITHUB.md L2). */
export const GITHUB_MANIFEST: PluginManifest = {
  toolset: "github",
  displayName: "GitHub",
  description: "List and open issues/pull requests, comment, and check CI status against an allowlisted set of repositories.",
  env: [
    {
      name: "GITHUB_TOKEN",
      description: "A fine-grained personal access token, scoped to the allowlisted repositories only",
      required: true,
      secret: true,
      docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    },
    {
      name: "GITHUB_ALLOWED_REPOS",
      description: 'Comma-separated "owner/name" repositories the toolset may act on — unset means none (secure default)',
      required: true,
      secret: false,
    },
    {
      name: "GITHUB_MODE",
      description: '"ro" (default) registers 5 read tools; "rw" also registers 3 write tools',
      required: false,
      secret: false,
    },
    {
      name: "GITHUB_API_BASE_URL",
      description: 'Override for GitHub Enterprise; defaults to "https://api.github.com"',
      required: false,
      secret: false,
    },
  ],
};
