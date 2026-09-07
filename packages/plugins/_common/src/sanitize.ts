/**
 * Moved to `@flowlathe/core` per PLAN-SANITIZATION-BOUNDARY.md §2 — `@flowlathe/runtime`'s
 * tool-registry choke point needs it and does not (and should not) depend on `plugin-common`.
 * Re-exported here unchanged so `plugin-searxng`/`plugin-discord`/`plugin-mcp` don't need a
 * single import updated.
 */
export { sanitizeUntrustedText, scrubUntrustedText } from "@flowlathe/core";
