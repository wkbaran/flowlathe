import { nodeFailureEvent, renderTemplate, type RuntimeHost } from "@flowlathe/core";
import { FirecrawlClient } from "@flowlathe/plugin-firecrawl";
import type { FetchSpec } from "./schema.js";

export interface FetchResult {
  /** Markdown/HTML content, truncation-marked by `FirecrawlClient` when over its `maxChars`
   *  cap — see PLAN-INTEGRATIONS.md §5.2. */
  content: string;
}

/** Same env-vars-only reconstruction as `@flowlathe/node-search`'s `clientFromEnv` — see that
 *  file's comment for why reading `process.env` here (rather than threading config through
 *  `RuntimeHost`) is correct for both the interpreter and the compiled-script path. */
function clientFromEnv(fetchImpl: typeof fetch, maxChars: number | undefined): FirecrawlClient {
  const apiKey = process.env["FIRECRAWL_API_KEY"];
  if (!apiKey) {
    throw new Error("Firecrawl is not configured (set FIRECRAWL_API_KEY)");
  }
  const crawlTimeoutMs = process.env["FIRECRAWL_CRAWL_TIMEOUT_MS"];
  return new FirecrawlClient({
    apiKey,
    fetchImpl,
    ...(process.env["FIRECRAWL_BASE_URL"] ? { baseUrl: process.env["FIRECRAWL_BASE_URL"] } : {}),
    ...(crawlTimeoutMs !== undefined ? { crawlTimeoutMs: Number(crawlTimeoutMs) } : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
    allowPrivateUrls: process.env["FLOWLATHE_ALLOW_PRIVATE_URLS"] === "1",
  });
}

/** Goes through §4.5's URL safety twice over, per PLAN-INTEGRATIONS.md §5.3: the canvas can
 *  validate a *literal* `urlTemplate` (no `{{vars}}`) at edit time (see Canvas.tsx), while this
 *  runtime path validates the actually-rendered URL on every activation — `FirecrawlClient.
 *  scrapeOne` already runs `checkUrlSafety` internally (including the post-redirect
 *  re-validation), returning `{url, error}` rather than throwing; this function turns that error
 *  into a `node_failed` event so a blocked URL fails the node with the reason in the log, not
 *  silently empty content. */
export async function runFetch(ctx: RuntimeHost, spec: FetchSpec, inputs: Record<string, string>): Promise<FetchResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  const url = renderTemplate(spec.urlTemplate, inputs);
  try {
    const client = clientFromEnv(ctx.net.fetch, spec.maxChars);
    const outcome = await client.scrapeOne(url, { formats: [spec.format] }, ctx.cancellation.signal);
    if (outcome.error !== undefined) {
      throw new Error(outcome.error);
    }
    const latencyMs = ctx.clock.now() - start;
    ctx.emit({
      kind: "node_finished",
      nodeId: spec.id,
      output: outcome.content,
      renderedPrompt: url,
      finishReason: "stop",
      latencyMs,
    });
    return { content: outcome.content };
  } catch (err) {
    ctx.emit(nodeFailureEvent(spec.id, err));
    throw err;
  }
}
