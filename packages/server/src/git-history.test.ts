import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphAtGitCommit, isGitWorkTree, listGitHistory } from "./git-history.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-git-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function git(args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

const CHAIN = `flow "Git Chain" {
  node a: prompt @(0, 0) {
    template = "v1"
    providerId = "mock"
    modelId = "m"
  }
}
`;

describe("isGitWorkTree", () => {
  it("is false for a plain directory with no git repo", () => {
    expect(isGitWorkTree(dir)).toBe(false);
  });

  it("is true inside an initialized repo", () => {
    git(["init", "-q"]);
    expect(isGitWorkTree(dir)).toBe(true);
  });
});

describe("listGitHistory / graphAtGitCommit", () => {
  it("returns an empty history for an untracked file", async () => {
    git(["init", "-q"]);
    await writeFile(join(dir, "git-chain.flow"), CHAIN);
    expect(listGitHistory(dir, "git-chain")).toEqual([]);
  });

  it("returns an empty history (not a throw) outside a git repo at all", () => {
    expect(listGitHistory(dir, "git-chain")).toEqual([]);
    expect(graphAtGitCommit(dir, "git-chain", "HEAD")).toBeUndefined();
  });

  it("lists commits newest first and reads a past commit's graph via git show", async () => {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(dir, "git-chain.flow"), CHAIN);
    git(["add", "git-chain.flow"]);
    git(["commit", "-q", "-m", "first"]);

    await writeFile(join(dir, "git-chain.flow"), CHAIN.replace("v1", "v2"));
    git(["add", "git-chain.flow"]);
    git(["commit", "-q", "-m", "second"]);

    const history = listGitHistory(dir, "git-chain");
    expect(history).toHaveLength(2);
    expect(history[0]!.message).toBe("second");
    expect(history[1]!.message).toBe("first");

    const oldGraph = graphAtGitCommit(dir, "git-chain", history[1]!.sha);
    expect(oldGraph?.nodes[0]?.data["template"]).toBe("v1");
    const newGraph = graphAtGitCommit(dir, "git-chain", history[0]!.sha);
    expect(newGraph?.nodes[0]?.data["template"]).toBe("v2");
  });

  it("returns undefined for a commit that doesn't exist", async () => {
    git(["init", "-q"]);
    expect(graphAtGitCommit(dir, "git-chain", "deadbeef")).toBeUndefined();
  });
});
