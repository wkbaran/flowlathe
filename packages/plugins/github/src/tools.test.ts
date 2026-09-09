import { describe, expect, it, vi } from "vitest";
import { GithubClient } from "./client.js";
import { createGithubToolset, type GithubToolsetOptions } from "./tools.js";
import { githubToolsetFromEnv } from "./env.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function toolByName(regs: ReturnType<typeof createGithubToolset>, name: string) {
  const reg = regs.find((r) => r.spec.name === name);
  if (!reg) throw new Error(`no tool named ${name}`);
  return reg;
}

describe("repo allowlist", () => {
  it("rejects a repo not in GITHUB_ALLOWED_REPOS and never calls the client", async () => {
    // `createGithubToolset` kicks off its own background `/rate_limit` liveness probe at
    // construction time (`CachedLivenessProbe`) — only a call to the issues endpoint itself
    // would indicate the allowlist check was bypassed.
    let called = false;
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname.includes("/issues")) called = true;
      return jsonResponse([]);
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/allowed"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_list_issues");
    const raw = await tool.handler({ repo: "owner/other" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not in GITHUB_ALLOWED_REPOS/);
    expect(called).toBe(false);
  });

  it("allows a repo on the allowlist regardless of case", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse([]));
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_list_issues");
    const raw = await tool.handler({ repo: "Owner/Repo" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

describe("toolOk key order", () => {
  it("puts ok first in the returned JSON text", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse([
        {
          number: 1,
          title: "Bug",
          state: "open",
          user: { login: "alice" },
          labels: [],
          comments: 0,
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/issues/1",
        },
      ]),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_list_issues");
    const raw = await tool.handler({ repo: "owner/repo" }, { activationKey: "n1" });
    expect(raw.indexOf('"ok"')).toBe(1);
  });
});

describe("github_create_issue labels argument", () => {
  it("accepts a comma-separated string", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ number: 1, html_url: "https://x" });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "rw" };
    const tool = toolByName(createGithubToolset(client, opts), "github_create_issue");
    await tool.handler({ repo: "owner/repo", title: "T", labels: "bug,ci" }, { activationKey: "n1" });
    expect(seenBody?.["labels"]).toEqual(["bug", "ci"]);
  });

  it("accepts a JSON array string", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ number: 1, html_url: "https://x" });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "rw" };
    const tool = toolByName(createGithubToolset(client, opts), "github_create_issue");
    await tool.handler({ repo: "owner/repo", title: "T", labels: '["bug","ci"]' }, { activationKey: "n1" });
    expect(seenBody?.["labels"]).toEqual(["bug", "ci"]);
  });
});

describe("sanitization", () => {
  it("scrubs zero-width and Unicode tag characters from an issue body", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/comments")
        ? jsonResponse([])
        : jsonResponse({
            number: 1,
            title: "Bug",
            state: "open",
            user: { login: "alice" },
            labels: [],
            comments: 0,
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/owner/repo/issues/1",
            body: `hidden${zeroWidthSpace}text\u{e0041}\u{e0042}`,
          }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_get_issue");
    const raw = await tool.handler({ repo: "owner/repo", number: 1 }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { body: string } };
    expect(parsed.data.body).toBe("hiddentext");
  });

  it("truncates a body longer than its cap", async () => {
    const longBody = "x".repeat(5000);
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/comments")
        ? jsonResponse([])
        : jsonResponse({
            number: 1,
            title: "Bug",
            state: "open",
            user: { login: "alice" },
            labels: [],
            comments: 0,
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/owner/repo/issues/1",
            body: longBody,
          }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_get_issue");
    const raw = await tool.handler({ repo: "owner/repo", number: 1 }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { body: string } };
    expect(parsed.data.body.length).toBe(4000);
  });

  it("scrub-then-truncates the diff, leaving its own truncation marker as the last thing in the string", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const bigPatch = `@@ -1 +1 @@${zeroWidthSpace}${"y".repeat(13_000)}`;
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/files")
        ? jsonResponse([{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: bigPatch }])
        : jsonResponse({
            number: 9,
            title: "PR",
            state: "open",
            draft: true,
            user: { login: "carol" },
            head: { ref: "feature/x" },
            base: { ref: "main" },
            updated_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/owner/repo/pull/9",
            body: "pr body",
          }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const tool = toolByName(createGithubToolset(client, opts), "github_get_pull_request");
    const raw = await tool.handler({ repo: "owner/repo", number: 9, includeDiff: true }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { diff: string } };
    expect(parsed.data.diff).not.toContain(zeroWidthSpace);
    expect(parsed.data.diff.endsWith("]")).toBe(true);
    expect(parsed.data.diff).toMatch(/\[truncated \d+ of \d+ chars\]$/);
  });
});

describe("githubToolsetFromEnv registration counts", () => {
  it("registers zero tools when unconfigured", () => {
    expect(githubToolsetFromEnv({})).toEqual([]);
  });

  it("with only GITHUB_TOKEN set, registers 5 read tools, all reporting an unavailableReason naming GITHUB_ALLOWED_REPOS", () => {
    const regs = githubToolsetFromEnv({ GITHUB_TOKEN: "t" });
    expect(regs.map((r) => r.spec.name).sort()).toEqual(
      ["github_get_checks", "github_get_issue", "github_get_pull_request", "github_list_issues", "github_list_pull_requests"].sort(),
    );
    for (const reg of regs) {
      expect(reg.unavailableReason?.()).toMatch(/GITHUB_ALLOWED_REPOS/);
    }
  });

  it("GITHUB_MODE=ro registers exactly the 5 read tools, no write tool name appears", () => {
    const regs = githubToolsetFromEnv({ GITHUB_TOKEN: "t", GITHUB_ALLOWED_REPOS: "o/r", GITHUB_MODE: "ro" });
    const names = regs.map((r) => r.spec.name);
    expect(names).toHaveLength(5);
    expect(names).not.toContain("github_create_issue");
    expect(names).not.toContain("github_comment");
    expect(names).not.toContain("github_create_pull_request");
  });

  it("GITHUB_MODE=rw registers all 8 tools", () => {
    const regs = githubToolsetFromEnv({ GITHUB_TOKEN: "t", GITHUB_ALLOWED_REPOS: "o/r", GITHUB_MODE: "rw" });
    const names = regs.map((r) => r.spec.name).sort();
    expect(names).toEqual(
      [
        "github_list_issues",
        "github_get_issue",
        "github_list_pull_requests",
        "github_get_pull_request",
        "github_get_checks",
        "github_create_issue",
        "github_comment",
        "github_create_pull_request",
      ].sort(),
    );
  });

  it("GITHUB_MODE=nonsense fails closed to 5 registrations, with a console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const regs = githubToolsetFromEnv({ GITHUB_TOKEN: "t", GITHUB_ALLOWED_REPOS: "o/r", GITHUB_MODE: "nonsense" });
    expect(regs).toHaveLength(5);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("unavailableReason liveness probe", () => {
  it("is undefined once the allowlist is non-empty and the rate_limit probe succeeds", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ resources: {} }));
    const client = new GithubClient({ token: "t", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const [reg] = createGithubToolset(client, opts);
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toBeUndefined();
  });

  it("reports unreachable once the cached probe fails (e.g. a bad token)", async () => {
    const fetchImpl = fakeFetch(() => new Response("Bad credentials", { status: 401 }));
    const client = new GithubClient({ token: "bad", fetchImpl });
    const opts: GithubToolsetOptions = { allowedRepos: new Set(["owner/repo"]), mode: "ro" };
    const [reg] = createGithubToolset(client, opts);
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toMatch(/not reachable or the token is invalid/);
  });
});
