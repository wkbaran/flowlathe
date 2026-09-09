import type { PluginManifest } from "@flowlathe/core";

export const GIT_MANIFEST: PluginManifest = {
  toolset: "git",
  displayName: "Git",
  description:
    "Run a fixed set of safe git subcommands against a server-configured local repository. Never runs git config/remote/clone/fetch/pull — identity, credentials, and remotes are the operator's to configure by hand.",
  env: [
    {
      name: "GIT_TOOL_ROOT",
      description: "Absolute path to the git work tree this toolset operates on",
      required: true,
      secret: false,
    },
    {
      name: "GIT_TOOL_MODE",
      description: '"ro" (default, 5 read-only tools) or "rw" (adds git_add/git_commit/git_create_branch/git_switch)',
      required: false,
      secret: false,
    },
    {
      name: "GIT_TOOL_ALLOW_PUSH",
      description: 'Set to "1" (together with GIT_TOOL_MODE=rw) to also register git_push',
      required: false,
      secret: false,
    },
    {
      name: "GIT_TOOL_REMOTE",
      description: 'Remote name git_push publishes to (default "origin")',
      required: false,
      secret: false,
    },
  ],
};
