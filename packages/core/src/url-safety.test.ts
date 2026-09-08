import { describe, expect, it } from "vitest";
import { checkUrlSafety, normalizeUrlString } from "./url-safety.js";

describe("checkUrlSafety", () => {
  it("allows an ordinary public https URL", () => {
    expect(checkUrlSafety("https://example.com/page")).toEqual({ ok: true, normalizedUrl: "https://example.com/page" });
  });

  it("rejects a non-http(s) scheme", () => {
    expect(checkUrlSafety("file:///etc/passwd").ok).toBe(false);
    expect(checkUrlSafety("gopher://example.com/").ok).toBe(false);
    expect(checkUrlSafety("data:text/plain;base64,aGk=").ok).toBe(false);
  });

  it("blocks the AWS/Azure/GCP metadata endpoint unconditionally, even with allowPrivate", () => {
    expect(checkUrlSafety("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(checkUrlSafety("http://169.254.169.254/latest/meta-data/", { allowPrivate: true }).ok).toBe(false);
  });

  it("blocks metadata.google.internal unconditionally", () => {
    expect(checkUrlSafety("http://metadata.google.internal/computeMetadata/v1/").ok).toBe(false);
    expect(checkUrlSafety("http://metadata.google.internal/", { allowPrivate: true }).ok).toBe(false);
  });

  it("blocks the AWS IMDSv2 IPv6 metadata endpoint unconditionally", () => {
    expect(checkUrlSafety("http://[fd00:ec2::254]/").ok).toBe(false);
    expect(checkUrlSafety("http://[fd00:ec2::254]/", { allowPrivate: true }).ok).toBe(false);
  });

  it("blocks a decimal-encoded loopback IP (127.0.0.1 == 2130706433)", () => {
    const result = checkUrlSafety("http://2130706433/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private or internal/);
  });

  it("blocks RFC1918 ranges", () => {
    expect(checkUrlSafety("http://10.0.0.5/").ok).toBe(false);
    expect(checkUrlSafety("http://172.16.0.1/").ok).toBe(false);
    expect(checkUrlSafety("http://192.168.1.1/").ok).toBe(false);
  });

  it("blocks loopback and link-local", () => {
    expect(checkUrlSafety("http://127.0.0.1/").ok).toBe(false);
    expect(checkUrlSafety("http://[::1]/").ok).toBe(false);
    expect(checkUrlSafety("http://169.254.1.1/").ok).toBe(false);
  });

  it("blocks IPv6 unique-local addresses", () => {
    expect(checkUrlSafety("http://[fc00::1]/").ok).toBe(false);
    expect(checkUrlSafety("http://[fd12:3456::1]/").ok).toBe(false);
  });

  it("blocks .local and .internal hostnames, and localhost", () => {
    expect(checkUrlSafety("http://myserver.local/").ok).toBe(false);
    expect(checkUrlSafety("http://api.internal/").ok).toBe(false);
    expect(checkUrlSafety("http://localhost/").ok).toBe(false);
  });

  it("blocks 0.0.0.0 and its shorthand 0, which route to loopback on Linux", () => {
    expect(checkUrlSafety("http://0.0.0.0/").ok).toBe(false);
    expect(checkUrlSafety("http://0/").ok).toBe(false);
  });

  it("blocks the IPv6 unspecified address ::", () => {
    expect(checkUrlSafety("http://[::]/").ok).toBe(false);
  });

  it("blocks an IPv4-mapped 0.0.0.0", () => {
    expect(checkUrlSafety("http://[::ffff:0:0]/").ok).toBe(false);
  });

  it("blocks localhost. (trailing dot is a valid FQDN for the same host)", () => {
    expect(checkUrlSafety("http://localhost./").ok).toBe(false);
  });

  it("blocks the RFC6598 CGNAT range (100.64.0.0/10, e.g. Tailscale addresses)", () => {
    expect(checkUrlSafety("http://100.64.1.1/").ok).toBe(false);
    expect(checkUrlSafety("http://100.127.255.255/").ok).toBe(false);
    expect(checkUrlSafety("http://100.63.255.255/").ok).toBe(true);
    expect(checkUrlSafety("http://100.128.0.0/").ok).toBe(true);
  });

  it("allows a private address when allowPrivate is set", () => {
    expect(checkUrlSafety("http://192.168.1.1/", { allowPrivate: true }).ok).toBe(true);
  });

  it("blocks a credential-bearing query param (e.g. a signed S3 URL)", () => {
    const result = checkUrlSafety(
      "https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc123&X-Amz-Expires=3600",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/credential-bearing/);
  });

  it("does not flag ordinary page-facet params like code, key, or session", () => {
    expect(checkUrlSafety("https://example.com/?code=abc&key=xyz&session=1").ok).toBe(true);
  });

  it("normalizes a model-emitted 'https:// example.com' whitespace glitch", () => {
    expect(normalizeUrlString("https:// example.com/path")).toBe("https://example.com/path");
    expect(checkUrlSafety("https:// example.com/path")).toEqual({ ok: true, normalizedUrl: "https://example.com/path" });
  });

  it("IDNA-encodes an internationalized domain host", () => {
    const result = checkUrlSafety("https://例え.jp/");
    expect(result.ok).toBe(true);
    expect(result.normalizedUrl).toContain("xn--");
  });

  it("rejects an unparseable URL", () => {
    expect(checkUrlSafety("not a url").ok).toBe(false);
  });
});
