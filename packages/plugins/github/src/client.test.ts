import { describe, expect, it, vi } from "vitest";
import { GithubClient } from "./client.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("GithubClient request headers", () => {
  it("sends auth, accept, and the pinned API version on every call", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return jsonResponse([]);
    });
    const client = new GithubClient({ token: "tok", fetchImpl });
    await client.listIssues("owner/repo");
    expect(seenHeaders?.["Authorization"]).toBe("Bearer tok");
    expect(seenHeaders?.["Accept"]).toBe("application/vnd.github+json");
    expect(seenHeaders?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(seenHeaders?.["User-Agent"]).toBe("flowlathe");
  });

  it("forwards the caller's signal to fetchImpl", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenSignal = init?.signal as AbortSignal;
      return jsonResponse([]);
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const controller = new AbortController();
    await client.listIssues("owner/repo", {}, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("GithubClient.listIssues", () => {
  it("returns a happy-path summary per issue", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse([
        {
          number: 1,
          title: "Bug",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }, "needs-triage"],
          comments: 3,
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/issues/1",
        },
      ]),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const issues = await client.listIssues("owner/repo");
    expect(issues).toEqual([
      {
        number: 1,
        title: "Bug",
        state: "open",
        author: "alice",
        labels: ["bug", "needs-triage"],
        commentCount: 3,
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/owner/repo/issues/1",
      },
    ]);
  });

  it("filters out items carrying a pull_request key", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse([
        {
          number: 1,
          title: "A real issue",
          state: "open",
          user: { login: "alice" },
          labels: [],
          comments: 0,
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/issues/1",
        },
        {
          number: 2,
          title: "Actually a PR",
          state: "open",
          user: { login: "bob" },
          labels: [],
          comments: 0,
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/issues/2",
          pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/2" },
        },
      ]),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const issues = await client.listIssues("owner/repo");
    expect(issues.map((i) => i.number)).toEqual([1]);
  });

  it("rejects a repo containing .. before any fetchImpl call", async () => {
    let called = false;
    const fetchImpl = fakeFetch(() => {
      called = true;
      return jsonResponse([]);
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    await expect(client.listIssues("a/../../x")).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("GithubClient.getIssue", () => {
  it("fetches the issue plus its most recent comments", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname.endsWith("/comments")) {
        return jsonResponse([
          { user: { login: "b" }, body: "second", created_at: "2026-01-02T00:00:00Z" },
          { user: { login: "a" }, body: "first", created_at: "2026-01-01T00:00:00Z" },
        ]);
      }
      return jsonResponse({
        number: 5,
        title: "Issue",
        state: "open",
        user: { login: "alice" },
        labels: [],
        comments: 2,
        updated_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/5",
        body: "the body",
      });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const detail = await client.getIssue("owner/repo", 5, { commentLimit: 2 });
    expect(detail.body).toBe("the body");
    expect(detail.comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("skips the comments request entirely when commentLimit is 0", async () => {
    let commentsCalled = false;
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname.endsWith("/comments")) commentsCalled = true;
      return jsonResponse({
        number: 5,
        title: "Issue",
        state: "open",
        user: { login: "alice" },
        labels: [],
        comments: 0,
        updated_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/5",
      });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const detail = await client.getIssue("owner/repo", 5, { commentLimit: 0 });
    expect(detail.comments).toEqual([]);
    expect(commentsCalled).toBe(false);
  });
});

describe("GithubClient.listPullRequests", () => {
  it("returns a happy-path summary per pull request", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse([
        {
          number: 9,
          title: "Add feature",
          state: "open",
          draft: false,
          user: { login: "carol" },
          head: { ref: "feature/x" },
          base: { ref: "main" },
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/pull/9",
        },
      ]),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const prs = await client.listPullRequests("owner/repo");
    expect(prs).toEqual([
      {
        number: 9,
        title: "Add feature",
        state: "open",
        draft: false,
        author: "carol",
        head: "feature/x",
        base: "main",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://github.com/owner/repo/pull/9",
      },
    ]);
  });
});

describe("GithubClient.getPullRequest", () => {
  function prResponse(): Response {
    return jsonResponse({
      number: 9,
      title: "Add feature",
      state: "open",
      draft: true,
      user: { login: "carol" },
      head: { ref: "feature/x" },
      base: { ref: "main" },
      updated_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/owner/repo/pull/9",
      body: "pr body",
    });
  }

  it("returns metadata plus the changed-file list without a diff by default", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/files")
        ? jsonResponse([{ filename: "a.ts", status: "modified", additions: 1, deletions: 2, patch: "@@ -1 +1 @@" }])
        : prResponse(),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const detail = await client.getPullRequest("owner/repo", 9);
    expect(detail.files).toEqual([{ path: "a.ts", status: "modified", additions: 1, deletions: 2 }]);
    expect(detail.filesTruncated).toBe(false);
    expect(detail.diff).toBeUndefined();
  });

  it("includes a concatenated per-file diff when includeDiff is true", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/files")
        ? jsonResponse([
            { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ patch-a @@" },
            { filename: "b.ts", status: "added", additions: 5, deletions: 0 },
          ])
        : prResponse(),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const detail = await client.getPullRequest("owner/repo", 9, { includeDiff: true });
    expect(detail.diff).toContain("a.ts");
    expect(detail.diff).toContain("@@ patch-a @@");
    expect(detail.diff).not.toContain("b.ts");
  });

  it("sets filesTruncated once the file list exceeds 100", async () => {
    const manyFiles = Array.from({ length: 150 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 0 }));
    const fetchImpl = fakeFetch((url) => (url.pathname.endsWith("/files") ? jsonResponse(manyFiles) : prResponse()));
    const client = new GithubClient({ token: "t", fetchImpl });
    const detail = await client.getPullRequest("owner/repo", 9);
    expect(detail.files).toHaveLength(100);
    expect(detail.filesTruncated).toBe(true);
  });
});

describe("GithubClient.getChecks", () => {
  it("merges modern check runs with the legacy combined status", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            check_runs: [
              { name: "build", status: "completed", conclusion: "success", html_url: "https://x/1", output: { summary: "ok" } },
            ],
          })
        : jsonResponse({ state: "success", statuses: [{ context: "legacy-ci", state: "success", target_url: "https://x/2" }] }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const result = await client.getChecks("owner/repo", "main");
    expect(result.state).toBe("success");
    expect(result.checks).toEqual([
      { name: "build", status: "completed", conclusion: "success", url: "https://x/1", outputSummary: "ok" },
      { name: "legacy-ci", status: "success", conclusion: "success", url: "https://x/2" },
    ]);
  });

  it("reports failure if any check run's conclusion is failing, even if the combined status is success", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({ check_runs: [{ name: "build", status: "completed", conclusion: "failure", html_url: "https://x/1" }] })
        : jsonResponse({ state: "success", statuses: [] }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const result = await client.getChecks("owner/repo", "main");
    expect(result.state).toBe("failure");
  });

  it("never surfaces output.text, only output.summary", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname.endsWith("/check-runs")
        ? jsonResponse({
            check_runs: [{ name: "build", status: "completed", conclusion: "failure", html_url: "https://x/1", output: { summary: "short" } }],
          })
        : jsonResponse({ state: "success", statuses: [] }),
    );
    const client = new GithubClient({ token: "t", fetchImpl });
    const result = await client.getChecks("owner/repo", "main");
    expect(result.checks[0]).not.toHaveProperty("outputText");
    expect(result.checks[0]?.outputSummary).toBe("short");
  });

  it("rejects a ref containing .. before any fetchImpl call", async () => {
    let called = false;
    const fetchImpl = fakeFetch(() => {
      called = true;
      return jsonResponse({});
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    await expect(client.getChecks("owner/repo", "a/../b")).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("GithubClient write operations", () => {
  it("createIssue returns the new issue's number and url", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ number: 42, html_url: "https://github.com/owner/repo/issues/42" }));
    const client = new GithubClient({ token: "t", fetchImpl });
    const result = await client.createIssue("owner/repo", { title: "New bug" });
    expect(result).toEqual({ number: 42, url: "https://github.com/owner/repo/issues/42" });
  });

  it("createComment returns the new comment's id and url", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: 7, html_url: "https://github.com/owner/repo/issues/1#issuecomment-7" }));
    const client = new GithubClient({ token: "t", fetchImpl });
    const result = await client.createComment("owner/repo", 1, "hello");
    expect(result).toEqual({ id: 7, url: "https://github.com/owner/repo/issues/1#issuecomment-7" });
  });

  it("createPullRequest defaults draft to true", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ number: 3, html_url: "https://github.com/owner/repo/pull/3" });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    await client.createPullRequest("owner/repo", { title: "T", head: "feature/x", base: "main" });
    expect(seenBody?.["draft"]).toBe(true);
  });

  it("createPullRequest honors an explicit draft: false", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ number: 3, html_url: "https://github.com/owner/repo/pull/3" });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    await client.createPullRequest("owner/repo", { title: "T", head: "feature/x", base: "main", draft: false });
    expect(seenBody?.["draft"]).toBe(false);
  });
});

describe("GithubClient 403/429 taxonomy", () => {
  it("403 + x-ratelimit-remaining: 0 fails immediately without retry, naming the reset time", async () => {
    let calls = 0;
    const resetEpoch = 1_800_000_000;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpoch) } });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    await expect(client.listIssues("owner/repo")).rejects.toThrow(new RegExp(new Date(resetEpoch * 1000).toISOString()));
    expect(calls).toBe(1);
  });

  it("403 + retry-after retries then succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetchImpl = fakeFetch(() => {
      attempt++;
      if (attempt === 1) return new Response("secondary limit", { status: 403, headers: { "retry-after": "0.01" } });
      return jsonResponse([]);
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const promise = client.listIssues("owner/repo");
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual([]);
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });

  it("403 with neither remaining:0 nor retry-after is an authorization failure naming the repo", async () => {
    const fetchImpl = fakeFetch(() => new Response("Resource not accessible by integration", { status: 403 }));
    const client = new GithubClient({ token: "t", fetchImpl });
    await expect(client.listIssues("owner/repo")).rejects.toThrow(/denied access to "owner\/repo"/);
  });

  it("429 + retry-after retries, bounded at 3 attempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0.001" } });
    });
    const client = new GithubClient({ token: "t", fetchImpl });
    const promise = client.listIssues("owner/repo");
    const expectation = expect(promise).rejects.toThrow(/HTTP 429/);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(calls).toBe(4); // initial attempt + 3 retries, then the loop gives up
    vi.useRealTimers();
  });
});

describe("GithubClient.isReachable", () => {
  it("returns true when /rate_limit responds successfully", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ resources: {} }));
    const client = new GithubClient({ token: "t", fetchImpl });
    expect(await client.isReachable()).toBe(true);
  });

  it("returns false on a 401 (bad token)", async () => {
    const fetchImpl = fakeFetch(() => new Response("Bad credentials", { status: 401 }));
    const client = new GithubClient({ token: "bad", fetchImpl });
    expect(await client.isReachable()).toBe(false);
  });

  it("returns false when the request fails outright", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch;
    const client = new GithubClient({ token: "t", fetchImpl });
    expect(await client.isReachable()).toBe(false);
  });
});
