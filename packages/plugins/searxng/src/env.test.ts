import { describe, expect, it } from "vitest";
import { searxngClientFromEnv, searxngToolsetFromEnv } from "./env.js";

describe("searxngClientFromEnv", () => {
  it("returns undefined when SEARXNG_BASE_URL is unset", () => {
    expect(searxngClientFromEnv({})).toBeUndefined();
  });

  it("builds a client with defaults applied from env", () => {
    const client = searxngClientFromEnv({
      SEARXNG_BASE_URL: "http://localhost:8080",
      SEARXNG_LANGUAGE: "en",
      SEARXNG_SAFESEARCH: "1",
    });
    expect(client?.baseUrl).toBe("http://localhost:8080");
  });
});

describe("searxngToolsetFromEnv", () => {
  it("registers zero tools when unconfigured (secure default)", () => {
    expect(searxngToolsetFromEnv({})).toEqual([]);
  });

  it("registers the search tool once configured", () => {
    const regs = searxngToolsetFromEnv({ SEARXNG_BASE_URL: "http://localhost:8080" });
    expect(regs.map((r) => r.spec.name)).toEqual(["searxng_search"]);
  });
});
