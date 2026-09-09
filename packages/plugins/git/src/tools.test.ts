import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInvokeMeta, ToolRegistration } from "@flowlathe/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitConfig } from "./config.js";
import { createGitToolset } from "./tools.js";

// `spawn` (used by `runArgv`, `@flowlathe/plugin-common`) is wrapped, not replaced — real git
// subprocesses still run for every functional test in this file. The "security" describe block
// below asserts this spy was never called, proving a rejected path/ref never reaches a
// subprocess at all, not merely that the tool call failed. Spying via `vi.spyOn` directly on the
// imported namespace object fails under ESM ("Module namespace is not configurable"); `vi.mock`
// with a passthrough factory is the supported way to instrument a named export while keeping its
// real behavior. `execFileSync` (this file's own fixture setup) is untouched by the mock.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(spawn);

const META: ToolInvokeMeta = { activationKey: "test" };

let repoDir: string;

function git(args: string[]): void {
  execFileSync("git", ["-C", repoDir, ...args], { stdio: "ignore" });
}

function gitCapture(args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
}

function baseEnv(): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/root" };
}

function roConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return { root: repoDir, env: baseEnv(), mode: "ro", allowPush: false, remote: "origin", ...overrides };
}

function rwConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return { root: repoDir, env: baseEnv(), mode: "rw", allowPush: false, remote: "origin", ...overrides };
}

function rwPushConfig(overrides: Partial<GitConfig> = {}): GitConfig {
  return { root: repoDir, env: baseEnv(), mode: "rw", allowPush: true, remote: "origin", ...overrides };
}

function findTool(registrations: ToolRegistration[], name: string): ToolRegistration {
  const found = registrations.find((r) => r.spec.name === name);
  if (!found) throw new Error(`tool "${name}" not registered`);
  return found;
}

async function invoke(registrations: ToolRegistration[], name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const tool = findTool(registrations, name);
  const raw = await tool.handler(args, META);
  return JSON.parse(raw);
}

beforeEach(() => {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), "flowlathe-plugin-git-tools-")));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "a.txt"), "hello\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "first commit"]);
  writeFileSync(join(repoDir, "a.txt"), "hello\nworld\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "second commit"]);
  git(["switch", "-c", "feature-x", "-q"]);
  git(["switch", "main", "-q"]);
  // staged + unstaged changes for status
  writeFileSync(join(repoDir, "a.txt"), "hello\nworld\nstaged\n");
  git(["add", "a.txt"]);
  writeFileSync(join(repoDir, "b.txt"), "untracked\n");
});

describe("read tools (ro mode)", () => {
  it("registers exactly the 5 read tools, by name", () => {
    const registrations = createGitToolset(roConfig());
    const names = registrations.map((r) => r.spec.name).sort();
    expect(names).toEqual(["git_diff", "git_list_branches", "git_log", "git_show", "git_status"].sort());
  });

  it("write tools are absent in ro mode, asserted by registration name", () => {
    const registrations = createGitToolset(roConfig());
    const names = registrations.map((r) => r.spec.name);
    expect(names).not.toContain("git_add");
    expect(names).not.toContain("git_commit");
    expect(names).not.toContain("git_create_branch");
    expect(names).not.toContain("git_switch");
    expect(names).not.toContain("git_push");
  });

  it("git_status reports the branch, staged change, and untracked file", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_status");
    expect(result.ok).toBe(true);
    const data = result.data as { branch: string; entries: Array<{ path: string; indexStatus: string; workTreeStatus: string }> };
    expect(data.branch).toBe("main");
    const aEntry = data.entries.find((e) => e.path === "a.txt");
    expect(aEntry?.indexStatus).toBe("M");
    const bEntry = data.entries.find((e) => e.path === "b.txt");
    expect(bEntry?.indexStatus).toBe("?");
    expect(bEntry?.workTreeStatus).toBe("?");
  });

  it("git_log returns commits newest first with sha/date/author/subject", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_log", { limit: 10 });
    expect(result.ok).toBe(true);
    const data = result.data as Array<{ sha: string; author: string; subject: string }>;
    expect(data).toHaveLength(2);
    expect(data[0]?.subject).toBe("second commit");
    expect(data[1]?.subject).toBe("first commit");
    expect(data[0]?.author).toBe("Test");
    expect(data[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("git_log honors a ref argument", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_log", { limit: 10, ref: "main" });
    expect(result.ok).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
  });

  it("git_diff shows the staged change against the previous commit", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_diff", { staged: true });
    expect(result.ok).toBe(true);
    const data = result.data as { diff: string };
    expect(data.diff).toContain("+staged");
  });

  it("git_show returns the commit metadata, body, and patch", async () => {
    const registrations = createGitToolset(roConfig());
    const sha = gitCapture(["rev-parse", "HEAD"]).trim();
    const result = await invoke(registrations, "git_show", { ref: sha });
    expect(result.ok).toBe(true);
    const data = result.data as { sha: string; author: string; body: string; patch: string };
    expect(data.sha).toBe(sha);
    expect(data.author).toBe("Test");
    expect(data.body).toContain("second commit");
    expect(data.patch).toContain("diff --git");
  });

  it("git_show with path returns raw file contents at that revision", async () => {
    const registrations = createGitToolset(roConfig());
    const firstSha = gitCapture(["log", "--format=%H"]).trim().split("\n").pop()!;
    const result = await invoke(registrations, "git_show", { ref: firstSha, path: "a.txt" });
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toBe("hello\n");
  });

  it("git_show refuses binary content rather than returning noise", async () => {
    writeFileSync(join(repoDir, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    git(["add", "bin.dat"]);
    git(["commit", "-q", "-m", "add binary"]);
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_show", { ref: "HEAD", path: "bin.dat" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Blocked:.*binary/);
  });

  it("git_list_branches lists branches with the current flag set correctly", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_list_branches");
    expect(result.ok).toBe(true);
    const data = result.data as Array<{ name: string; current: boolean }>;
    const main = data.find((b) => b.name === "main");
    const feature = data.find((b) => b.name === "feature-x");
    expect(main?.current).toBe(true);
    expect(feature?.current).toBe(false);
  });
});

describe("security: rejected before any subprocess is spawned", () => {
  beforeEach(() => {
    spawnSpy.mockClear();
  });

  it("refuses a path outside the root ('../../etc/passwd') without spawning git", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_log", { path: "../../etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Blocked:/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("refuses an absolute path without spawning git", async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_log", { path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Blocked:/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('refuses a ref that looks like a flag ("--output=/tmp/pwned") without spawning git', async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_show", { ref: "--output=/tmp/pwned" });
    expect(result.ok).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('refuses a ref that looks like a flag ("-o") without spawning git', async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_show", { ref: "-o" });
    expect(result.ok).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('refuses a ref containing a ".." path component ("a/../../b") without spawning git', async () => {
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_show", { ref: "a/../../b" });
    expect(result.ok).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe("write tools (rw mode)", () => {
  it("registers exactly the 9 read+write tools, by name", () => {
    const registrations = createGitToolset(rwConfig());
    const names = registrations.map((r) => r.spec.name).sort();
    expect(names).toEqual(
      ["git_status", "git_log", "git_diff", "git_show", "git_list_branches", "git_add", "git_commit", "git_create_branch", "git_switch"].sort(),
    );
    expect(names).not.toContain("git_push");
  });

  it("git_add + git_commit produces a real commit, verified by re-reading it through git_log", async () => {
    writeFileSync(join(repoDir, "new-file.txt"), "content\n");
    const registrations = createGitToolset(rwConfig());

    const addResult = await invoke(registrations, "git_add", { paths: "new-file.txt" });
    expect(addResult.ok).toBe(true);

    const commitResult = await invoke(registrations, "git_commit", { message: "add new-file.txt" });
    expect(commitResult.ok).toBe(true);
    const commitData = commitResult.data as { sha: string; subject: string };
    expect(commitData.subject).toBe("add new-file.txt");
    expect(commitData.sha).toMatch(/^[0-9a-f]{40}$/);

    const logResult = await invoke(registrations, "git_log", { limit: 1 });
    const logData = logResult.data as Array<{ sha: string; subject: string }>;
    expect(logData[0]?.subject).toBe("add new-file.txt");
    expect(logData[0]?.sha).toBe(commitData.sha);
  });

  it("git_add accepts a JSON array of paths too", async () => {
    writeFileSync(join(repoDir, "x1.txt"), "1\n");
    writeFileSync(join(repoDir, "x2.txt"), "2\n");
    const registrations = createGitToolset(rwConfig());
    const result = await invoke(registrations, "git_add", { paths: ["x1.txt", "x2.txt"] });
    expect(result.ok).toBe(true);
    const status = await invoke(registrations, "git_status");
    const entries = (status.data as { entries: Array<{ path: string; indexStatus: string }> }).entries;
    expect(entries.find((e) => e.path === "x1.txt")?.indexStatus).toBe("A");
    expect(entries.find((e) => e.path === "x2.txt")?.indexStatus).toBe("A");
  });

  it("git_commit with nothing staged returns ok:false with git's own message, and does not throw", async () => {
    const registrations = createGitToolset(rwConfig());
    // undo the beforeEach's staged change so there is genuinely nothing to commit
    git(["reset", "--hard", "HEAD"]);
    const result = await invoke(registrations, "git_commit", { message: "should fail" });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  });

  it("a commit message with zero-width and Unicode tag characters comes back scrubbed", async () => {
    writeFileSync(join(repoDir, "y.txt"), "y\n");
    const registrations = createGitToolset(rwConfig());
    await invoke(registrations, "git_add", { paths: "y.txt" });
    const hidden = "hello​world\u{E0041}\u{E0042}";
    const result = await invoke(registrations, "git_commit", { message: hidden });
    expect(result.ok).toBe(true);
    const subject = (result.data as { subject: string }).subject;
    expect(subject).not.toContain("​");
    expect(subject).not.toContain("\u{E0041}");
  });

  it("git_create_branch creates and switches to a new branch", async () => {
    const registrations = createGitToolset(rwConfig());
    const result = await invoke(registrations, "git_create_branch", { name: "feature-y" });
    expect(result.ok).toBe(true);
    expect(gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature-y");
  });

  it("git_switch to a nonexistent branch returns ok:false with git's message", async () => {
    const registrations = createGitToolset(rwConfig());
    const result = await invoke(registrations, "git_switch", { ref: "does-not-exist" });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("git_switch to an existing branch succeeds", async () => {
    const registrations = createGitToolset(rwConfig());
    const result = await invoke(registrations, "git_switch", { ref: "feature-x" });
    expect(result.ok).toBe(true);
    expect(gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature-x");
  });
});

describe("push (rw + allowPush only)", () => {
  it("git_push is absent without GIT_TOOL_ALLOW_PUSH", () => {
    const registrations = createGitToolset(rwConfig());
    expect(registrations.map((r) => r.spec.name)).not.toContain("git_push");
  });

  it("git_push is present with rw + allowPush (10 total)", () => {
    const registrations = createGitToolset(rwPushConfig());
    const names = registrations.map((r) => r.spec.name);
    expect(names).toContain("git_push");
    expect(names).toHaveLength(10);
  });
});

describe("diff truncation", () => {
  it("a diff longer than DIFF_MAX_CHARS carries its truncation marker as the last thing in the string", async () => {
    writeFileSync(join(repoDir, "big.txt"), "x".repeat(30_000));
    git(["add", "big.txt"]);
    const registrations = createGitToolset(roConfig());
    const result = await invoke(registrations, "git_diff", { staged: true });
    expect(result.ok).toBe(true);
    const diff = (result.data as { diff: string }).diff;
    expect(diff.endsWith("chars]")).toBe(true);
    expect(diff).toContain("[truncated 12000 of");
  });
});
