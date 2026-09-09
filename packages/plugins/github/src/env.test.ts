import { describe, expect, it, vi } from "vitest";
import { githubClientFromEnv, githubConfigFromEnv, githubToolsetFromEnv } from "./env.js";

describe("githubConfigFromEnv", () => {
  it("returns undefined when GITHUB_TOKEN is unset", () => {
    expect(githubConfigFromEnv({})).toBeUndefined();
  });

  it("returns undefined when GITHUB_TOKEN is an empty string", () => {
    expect(githubConfigFromEnv({ GITHUB_TOKEN: "" })).toBeUndefined();
  });

  it("builds a config with an empty allowlist when only the token is set", () => {
    const config = githubConfigFromEnv({ GITHUB_TOKEN: "t" });
    expect(config).toEqual({
      token: "t",
      apiBaseUrl: "https://api.github.com",
      allowedRepos: new Set(),
      mode: "ro",
    });
  });

  it("parses a comma-separated allowlist, lowercased", () => {
    const config = githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_ALLOWED_REPOS: "Owner/Repo, other/thing " });
    expect(config?.allowedRepos).toEqual(new Set(["owner/repo", "other/thing"]));
  });

  it("strips a trailing slash from an overridden API base URL", () => {
    const config = githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3/" });
    expect(config?.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
  });

  it("defaults GITHUB_MODE to ro when unset", () => {
    expect(githubConfigFromEnv({ GITHUB_TOKEN: "t" })?.mode).toBe("ro");
  });

  it("accepts GITHUB_MODE=rw", () => {
    expect(githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_MODE: "rw" })?.mode).toBe("rw");
  });

  it("fails closed to ro on an unrecognized GITHUB_MODE, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_MODE: "nonsense" })?.mode).toBe("ro");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("githubClientFromEnv", () => {
  it("returns undefined when unconfigured", () => {
    expect(githubClientFromEnv({})).toBeUndefined();
  });

  it("builds a client once a token is set", () => {
    expect(githubClientFromEnv({ GITHUB_TOKEN: "t" })).toBeInstanceOf(Object);
  });
});

describe("githubToolsetFromEnv (stub — real registrations land in C3)", () => {
  it("returns no registrations regardless of env", () => {
    expect(githubToolsetFromEnv({ GITHUB_TOKEN: "t", GITHUB_ALLOWED_REPOS: "o/r" })).toEqual([]);
  });
});
