import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitConfigFromEnv } from "./config.js";

let repoDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), "flowlathe-plugin-git-")));
  execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoDir, "config", "commit.gpgsign", "false"]);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("gitConfigFromEnv", () => {
  it("returns undefined when GIT_TOOL_ROOT is unset", () => {
    expect(gitConfigFromEnv({})).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns undefined with a warning for a non-existent path", () => {
    const missing = join(repoDir, "does-not-exist");
    expect(gitConfigFromEnv({ GIT_TOOL_ROOT: missing })).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/does not exist/);
  });

  it("returns undefined with a warning for a plain file", () => {
    const filePath = join(repoDir, "a-file.txt");
    writeFileSync(filePath, "hi");
    expect(gitConfigFromEnv({ GIT_TOOL_ROOT: filePath })).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not a directory/);
  });

  it("returns undefined with a warning for a directory that is not a git work tree", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "flowlathe-plugin-git-not-a-repo-"));
    expect(gitConfigFromEnv({ GIT_TOOL_ROOT: notARepo })).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not a git work tree/);
  });

  it("returns a valid config for a real git work tree, defaulting to ro mode and no push", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir });
    expect(cfg).toBeDefined();
    expect(cfg?.root).toBe(repoDir);
    expect(cfg?.mode).toBe("ro");
    expect(cfg?.allowPush).toBe(false);
    expect(cfg?.remote).toBe("origin");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("honors GIT_TOOL_MODE=rw", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, GIT_TOOL_MODE: "rw" });
    expect(cfg?.mode).toBe("rw");
    expect(cfg?.allowPush).toBe(false);
  });

  it("honors GIT_TOOL_ALLOW_PUSH=1 together with rw", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, GIT_TOOL_MODE: "rw", GIT_TOOL_ALLOW_PUSH: "1" });
    expect(cfg?.mode).toBe("rw");
    expect(cfg?.allowPush).toBe(true);
  });

  it("ignores GIT_TOOL_ALLOW_PUSH=1 without rw, and warns", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, GIT_TOOL_ALLOW_PUSH: "1" });
    expect(cfg?.mode).toBe("ro");
    expect(cfg?.allowPush).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/GIT_TOOL_ALLOW_PUSH/);
  });

  it("fails closed to ro for an unrecognized GIT_TOOL_MODE, with a warning", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, GIT_TOOL_MODE: "nonsense" });
    expect(cfg?.mode).toBe("ro");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/GIT_TOOL_MODE/);
  });

  it("honors a custom GIT_TOOL_REMOTE", () => {
    const cfg = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, GIT_TOOL_REMOTE: "upstream" });
    expect(cfg?.remote).toBe("upstream");
  });

  it("never leaks unrelated credentials into the child environment — the test that stands between a git hook and every credential the server holds", () => {
    const cfg = gitConfigFromEnv({
      GIT_TOOL_ROOT: repoDir,
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      FIRECRAWL_API_KEY: "leak",
      GITHUB_TOKEN: "leak2",
      SPOTIFY_CLIENT_SECRET: "leak3",
    });
    expect(cfg).toBeDefined();
    expect(cfg?.env["FIRECRAWL_API_KEY"]).toBeUndefined();
    expect(cfg?.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(cfg?.env["SPOTIFY_CLIENT_SECRET"]).toBeUndefined();
    expect(Object.keys(cfg!.env)).not.toContain("FIRECRAWL_API_KEY");
    expect(Object.keys(cfg!.env)).not.toContain("GITHUB_TOKEN");
    expect(cfg?.env["PATH"]).toBe("/usr/bin:/bin");
    expect(cfg?.env["HOME"]).toBe("/home/operator");
    expect(cfg?.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(cfg?.env["GIT_PAGER"]).toBe("cat");
    expect(cfg?.env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(cfg?.env["LANG"]).toBe("C.UTF-8");
  });

  it("carries SSH_AUTH_SOCK only when set", () => {
    const without = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir });
    expect(Object.keys(without!.env)).not.toContain("SSH_AUTH_SOCK");

    const withSock = gitConfigFromEnv({ GIT_TOOL_ROOT: repoDir, SSH_AUTH_SOCK: "/tmp/ssh.sock" });
    expect(withSock?.env["SSH_AUTH_SOCK"]).toBe("/tmp/ssh.sock");
  });
});
