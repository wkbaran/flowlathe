/** PLAN-NETWORK-POSTURE.md: the flowlathe API is unauthenticated, so the only defense against a
 *  DNS-rebinding-style attack (a public web page whose script sends a request that lands on a
 *  loopback-bound server with an attacker-controlled `Host` header) is checking that header
 *  against an allowlist before any route runs. This module is the entire security surface for
 *  that check — zero dependencies, pure, unit-testable in isolation from Fastify. */

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

/** Normalizes a raw `Host` header value for exact-match comparison. Deliberately conservative:
 *  - lowercased, so `LOCALHOST` and `localhost` are the same entry;
 *  - a single trailing dot is stripped, since `localhost.` is a valid FQDN for `localhost` and a
 *    naive `===` would treat it as a different (allowed-through-denial) host;
 *  - a bracketed IPv6 authority (`[::1]:4310`) has its brackets unwrapped;
 *  - a trailing `:<port>` is stripped, but never in a way that would truncate a bare (unbracketed)
 *    IPv6 literal like `::1` — the port is irrelevant to this check either way (see
 *    `isHostAllowed`'s doc comment), so when it's ambiguous we simply don't strip. */
export function normalizeHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let host = raw.trim().toLowerCase();
  if (host.length === 0) return undefined;

  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx !== -1) {
      host = host.slice(1, closeIdx);
    }
  } else {
    const colonCount = (host.match(/:/g) ?? []).length;
    // A bare IPv6 literal has 2+ colons (e.g. "::1"); only strip a port suffix when there's
    // exactly one colon, i.e. this is unambiguously "host:port", not an IPv6 address.
    if (colonCount === 1) {
      const portIdx = host.lastIndexOf(":");
      const portPart = host.slice(portIdx + 1);
      if (/^\d+$/.test(portPart)) {
        host = host.slice(0, portIdx);
      }
    }
  }

  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  return host.length > 0 ? host : undefined;
}

/** Resolves the operator-configured allowlist from the environment.
 *  - `FLOWLATHE_ALLOWED_HOSTS`: comma-separated hostnames, **added** to `DEFAULT_ALLOWED_HOSTS`.
 *  - `FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE=1`: the configured list **replaces** the defaults instead
 *    of adding to them.
 *  Two independent knobs so an operator can extend the loopback posture without having to also
 *  re-specify loopback, or narrow it deliberately when they want to. */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["FLOWLATHE_ALLOWED_HOSTS"] ?? "";
  const configured = raw
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry): entry is string => entry !== undefined);

  const exclusive = env["FLOWLATHE_ALLOWED_HOSTS_EXCLUSIVE"] === "1";
  const base = exclusive ? [] : DEFAULT_ALLOWED_HOSTS;

  return Array.from(new Set([...base, ...configured]));
}

/** Exact match only, after normalization — never a suffix/`endsWith` check (`evil-localhost`
 *  must not match `localhost`). Default-deny: a missing/empty `Host` header is rejected, not
 *  waved through. The port is ignored entirely (normalization strips it) — this check is about
 *  which hostname a request claims to be for, not which port it arrived on; keeping the port out
 *  of the comparison also means a reverse proxy on a different port doesn't need special-casing.
 *  `0.0.0.0` is deliberately never in `DEFAULT_ALLOWED_HOSTS` and must never be added to it: it's
 *  a *bind* address, not a `Host` value, and browsers on Linux/macOS will route
 *  `http://0.0.0.0:<port>` to a loopback-bound server (the "0.0.0.0 day" bug class) — allowlisting
 *  it here would reopen exactly the hole this module exists to close. */
export function isHostAllowed(raw: string | undefined, allowed: readonly string[]): boolean {
  const host = normalizeHost(raw);
  if (host === undefined) return false;
  return allowed.includes(host);
}
