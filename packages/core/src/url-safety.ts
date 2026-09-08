/**
 * URL-safety checks for outbound requests whose target isn't operator-configured — the Firecrawl
 * toolset and the `fetch` node kind (PLAN-INTEGRATIONS.md §4.5) are the first places flowlathe
 * hands a URL to the network that came from a model's tool arguments, a rendered template, or a
 * link inside a page that was itself scraped. Every other outbound URL in this codebase (an
 * Ollama base URL, an MCP server URL) is operator-configured, which is why nothing like this
 * existed before — see CLAUDE.md's note on dropping Flowise's MCP SSRF check for that reasoning.
 *
 * Isomorphic and zero-I/O by design (no `node:*` imports — see CLAUDE.md's core-isomorphism
 * lesson) so the canvas can warn at edit time and the server can enforce at call time from the
 * same logic. Ported from hermes-agent's `tools/url_safety.py` — the *checks*, not the code.
 *
 * Known, deliberate gap: DNS-rebinding (TOCTOU) closure is NOT implemented. Hermes closes this by
 * re-validating at TCP-connect time and dialing the already-validated IP directly (with the
 * original Host/SNI preserved) rather than trusting a second DNS lookup. That needs a custom
 * fetch dispatcher/connector — a meaningful chunk of work — and the threat (an attacker who
 * controls DNS *and* is specifically targeting a single-user local server) is thin. Recorded here
 * rather than left for the next agent to wonder whether it was considered.
 */

export interface UrlSafetyOptions {
  /** Mirrors `FLOWLATHE_ALLOW_PRIVATE_URLS=1` — lets an operator deliberately scrape their own
   *  intranet. Never overrides the cloud-metadata-endpoint block (see `isCloudMetadataHost`). */
  allowPrivate?: boolean;
}

export interface UrlSafetyVerdict {
  ok: boolean;
  /** Present when `ok` is false. Always starts with "Blocked:" so it reads sensibly appended
   *  directly to a node's failure log, per PLAN-INTEGRATIONS.md §5.3. */
  reason?: string;
  /** Present when `ok` is true — the URL after whitespace repair and IDNA/percent-encoding
   *  normalization (via the platform `URL` class). Use this, not the raw input, for the actual
   *  request. */
  normalizedUrl?: string;
}

/** A local model emitting `https:// example.com` (whitespace after the scheme separator) is a
 *  common enough failure mode to fix outright rather than reject. */
const SCHEME_WHITESPACE = /^(https?:)\/\/\s+/i;

/** `URL` already IDNA/percent-encodes the host and normalizes numeric-IP encoding tricks
 *  (decimal/octal/hex/shorthand all canonicalize to dotted-decimal — verified against Node's
 *  implementation), so "normalize" here is just the whitespace repair before handing off to it. */
export function normalizeUrlString(raw: string): string {
  return raw.trim().replace(SCHEME_WHITESPACE, "$1//");
}

const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog"]);
/** AWS IMDS (v1 and v2) and Azure/GCP/Alibaba/DigitalOcean all serve their metadata endpoint at
 *  this same link-local address; blocked unconditionally, never behind `allowPrivate`. */
const METADATA_IPV4 = "169.254.169.254";
/** AWS IMDSv2's IPv6 metadata endpoint. */
const METADATA_IPV6 = "fd00:ec2::254";

/** Deliberately narrow — `code`, `key`, and `session` are common, ordinary page-facet param
 *  names excluded on purpose (per hermes-agent's own comment), not an oversight. */
const CREDENTIAL_QUERY_PARAMS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "client_secret",
  "signature",
  "x-amz-signature",
  "x_amz_signature",
  "auth_token",
  "authtoken",
  "id_token",
  "refresh_token",
]);

function ipv4Octets(hostname: string): [number, number, number, number] | undefined {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return undefined;
  return parts as [number, number, number, number];
}

/** `::ffff:127.0.0.1`-shaped addresses canonicalize (via the platform `URL` class) to a hex
 *  form like `::ffff:7f00:1` — extract the embedded IPv4 back out of the last two hex groups. */
function ipv4MappedOctets(hostnameNoBrackets: string): [number, number, number, number] | undefined {
  const m = hostnameNoBrackets.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return undefined;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isCloudMetadataHost(hostname: string): boolean {
  const bare = stripBrackets(hostname).toLowerCase();
  if (METADATA_HOSTNAMES.has(bare)) return true;
  const v4 = ipv4Octets(bare) ?? ipv4MappedOctets(bare);
  if (v4 && v4.join(".") === METADATA_IPV4) return true;
  if (bare === METADATA_IPV6) return true;
  return false;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isPrivateOrInternalHost(hostname: string): boolean {
  // A trailing dot is a valid FQDN for the same host (`localhost.` === `localhost`) — a naive
  // `===`/`endsWith` would let it slip past every check below. See allowed-hosts.ts's
  // normalizeHost, which documents and closes the identical bypass for the Host-header allowlist;
  // `core` can't import from `server`, so this is a deliberate re-implementation, kept in sync by
  // hand rather than shared.
  let bare = stripBrackets(hostname).toLowerCase();
  if (bare.endsWith(".") && bare.length > 1) bare = bare.slice(0, -1);

  if (bare === "localhost" || bare.endsWith(".local") || bare.endsWith(".internal")) return true;

  const v4 = ipv4Octets(bare) ?? ipv4MappedOctets(bare);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8 — routes to loopback on Linux ("0.0.0.0 day")
    if (a === 10) return true; // RFC1918 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 100.64.0.0/10 (CGNAT, incl. Tailscale)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    return false;
  }

  // IPv6: unspecified (::), loopback (::1), link-local (fe80::/10), unique-local (fc00::/7, i.e.
  // fc00::-fdff::).
  if (bare === "::") return true;
  if (bare === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^f[cd]:/.test(bare)) return true;

  return false;
}

/**
 * Runs every check from PLAN-INTEGRATIONS.md §4.5 against a single URL: scheme allowlist,
 * unconditional cloud-metadata blocking, private/internal-address blocking (skippable via
 * `allowPrivate`), and a credential-bearing-query-param refusal. Does NOT follow redirects —
 * call this again on a post-redirect final URL (see the module doc comment and
 * `plugin-firecrawl`'s use of `metadata.sourceURL`).
 */
export function checkUrlSafety(raw: string, opts: UrlSafetyOptions = {}): UrlSafetyVerdict {
  let url: URL;
  try {
    url = new URL(normalizeUrlString(raw));
  } catch {
    return { ok: false, reason: "Blocked: not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Blocked: unsupported URL scheme "${url.protocol.replace(/:$/, "")}"` };
  }

  if (isCloudMetadataHost(url.hostname)) {
    return { ok: false, reason: "Blocked: URL targets a cloud metadata endpoint" };
  }

  if (!opts.allowPrivate && isPrivateOrInternalHost(url.hostname)) {
    return { ok: false, reason: "Blocked: URL targets a private or internal network address" };
  }

  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase())) {
      return { ok: false, reason: `Blocked: URL carries a credential-bearing query parameter ("${name}")` };
    }
  }

  return { ok: true, normalizedUrl: url.toString() };
}
