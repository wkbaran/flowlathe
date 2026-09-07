import { describe, expect, it } from "vitest";
import { firecrawlClientFromEnv, firecrawlToolsetFromEnv } from "./env.js";

describe("firecrawlClientFromEnv", () => {
  it("returns undefined when FIRECRAWL_API_KEY is unset", () => {
    expect(firecrawlClientFromEnv({})).toBeUndefined();
  });

  it("builds a client once configured", () => {
    const client = firecrawlClientFromEnv({ FIRECRAWL_API_KEY: "key", FIRECRAWL_BASE_URL: "http://localhost:3002" });
    expect(client?.baseUrl).toBe("http://localhost:3002");
  });
});

describe("firecrawlToolsetFromEnv", () => {
  it("registers zero tools when unconfigured (secure default)", () => {
    expect(firecrawlToolsetFromEnv({})).toEqual([]);
  });

  it("registers all three tools once configured", () => {
    const regs = firecrawlToolsetFromEnv({ FIRECRAWL_API_KEY: "key" });
    expect(regs.map((r) => r.spec.name).sort()).toEqual(["firecrawl_crawl", "firecrawl_map", "firecrawl_scrape"]);
  });
});
