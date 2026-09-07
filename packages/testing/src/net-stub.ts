/**
 * A deterministic, table-driven stand-in for `RuntimeHost.net.fetch`, for the `search`/`fetch`
 * node kinds' parity and unit tests — same shape as the mock provider's response table
 * (`@flowlathe/providers`'s `mockResponseKey`), so a template-rendering regression surfaces as a
 * *missing key* rather than a silently different answer (PLAN.md's design trap 8, extended to
 * outbound HTTP per PLAN-INTEGRATIONS.md §5.3).
 */
export function netStubFetch(table: Map<string, string>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const body = table.get(url);
    if (body === undefined) {
      throw new Error(`no net stub registered for ${url}`);
    }
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

/** Mirrors `parity.ts`'s `injectResponseTable` for the mock provider: swaps the compiled
 *  script's `net: { fetch: globalThis.fetch }` for a stub built from the same URL->JSON-body
 *  table used on the interpreter side, so both paths see identical canned network responses. */
export function injectNetStubTable(script: string, table: Map<string, string>): string {
  const entries = [...table.entries()].map(([key, value]) => `  [${JSON.stringify(key)}, ${JSON.stringify(value)}],`).join("\n");
  const helper = `
function __netStub(table) {
  return async (input) => {
    const url = String(input);
    const body = table.get(url);
    if (body === undefined) throw new Error(\`no net stub registered for \${url}\`);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
const __NET_TABLE = new Map([
${entries}
]);
`;
  return helper + script.replace("net: { fetch: globalThis.fetch }", "net: { fetch: __netStub(__NET_TABLE) }");
}
