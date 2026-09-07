import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_HOSTS, isHostAllowed, resolveAllowedHosts } from "./allowed-hosts.js";

describe("isHostAllowed", () => {
  const allowed = ["127.0.0.1", "localhost", "::1"];

  it.each([
    ["127.0.0.1"],
    ["127.0.0.1:4310"],
    ["localhost"],
    ["LOCALHOST:4310"],
    ["localhost."],
    ["[::1]:4310"],
    ["::1"],
  ])("allows %s", (host) => {
    expect(isHostAllowed(host, allowed)).toBe(true);
  });

  it.each([
    ["evil.example"],
    ["evil.example:4310"],
    ["127.0.0.1.evil.com"],
    ["0.0.0.0:4310"],
    [""],
    [undefined],
  ])("rejects %s", (host) => {
    expect(isHostAllowed(host, allowed)).toBe(false);
  });

  it("never allowlists 0.0.0.0 by default", () => {
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain("0.0.0.0");
  });

  it("does not suffix-match", () => {
    expect(isHostAllowed("evil-localhost", allowed)).toBe(false);
  });
});

describe("resolveAllowedHosts", () => {
  it("returns the defaults when nothing is configured", () => {
    expect(resolveAllowedHosts({})).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_HOSTS]));
    expect(resolveAllowedHosts({})).toHaveLength(DEFAULT_ALLOWED_HOSTS.length);
  });

  it("adds configured hosts to the defaults", () => {
    const result = resolveAllowedHosts({ FLOWLATHE_ALLOWED_HOSTS: "flowlathe.lan,other.example" });
    expect(result).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_HOSTS, "flowlathe.lan", "other.example"]));
    expect(result).toHaveLength(DEFAULT_ALLOWED_HOSTS.length + 2);
  });

  it("replaces the defaults in exclusive mode", () => {
    const result = resolveAllowedHosts({
      FLOWLATHE_ALLOWED_HOSTS: "flowlathe.lan",
      FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE: "1",
    });
    expect(result).toEqual(["flowlathe.lan"]);
  });

  it("drops whitespace and empty entries", () => {
    const result = resolveAllowedHosts({ FLOWLATHE_ALLOWED_HOSTS: " flowlathe.lan , , " });
    expect(result).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_HOSTS, "flowlathe.lan"]));
    expect(result).toHaveLength(DEFAULT_ALLOWED_HOSTS.length + 1);
  });

  it("dedupes an entry that duplicates a default", () => {
    const result = resolveAllowedHosts({ FLOWLATHE_ALLOWED_HOSTS: "localhost" });
    expect(result).toHaveLength(DEFAULT_ALLOWED_HOSTS.length);
  });
});
