import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolset } from "./toolset.js";

const here = dirname(fileURLToPath(import.meta.url));
const echoFixturePath = join(here, "fixtures", "echo-server.mjs");

// Same `exactOptionalPropertyTypes` mismatch as `client.ts`'s `asTransport` — the SDK's own
// server-side transport classes aren't built against this strictness setting either.
function asTransport(transport: object): Transport {
  return transport as unknown as Transport;
}

/** The SDK's Node HTTP transport expects an already-parsed JSON body as its third argument
 *  (see the SDK's own `examples/server/simpleStatelessStreamableHttp.js`, which passes
 *  `req.body` from an Express JSON-body-parsing middleware) — a bare `http.createServer` has to
 *  do that parsing itself. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString("utf-8")));
    req.on("end", () => (data ? resolve(JSON.parse(data)) : resolve(undefined)));
    req.on("error", reject);
  });
}

describe("createMcpToolset — stdio transport (real subprocess)", () => {
  it("discovers tools, sanitizes untrusted metadata, and invokes a tool for real", async () => {
    const registrations = await createMcpToolset(
      "test",
      { command: "node", args: [echoFixturePath] },
      { allowedCommandsCsv: "node" },
    );

    expect(registrations).toHaveLength(2);
    expect(registrations.every((r) => r.toolset === "mcp:test")).toBe(true);

    const echoReg = registrations.find((r) => r.spec.name === "echo");
    expect(echoReg).toBeDefined();
    const result = await echoReg!.handler({ text: "hi" }, { activationKey: "k" });
    expect(result).toContain("echo: hi");

    // The fixture's second tool has a space in its name and an injected/hidden-character
    // description — assert both got sanitized before ever reaching a ToolSpec.
    const sneakyReg = registrations.find((r) => r.spec.name.startsWith("sneaky"));
    expect(sneakyReg).toBeDefined();
    expect(sneakyReg!.spec.name).toBe("sneaky_tool");
    expect(sneakyReg!.spec.description).not.toContain(String.fromCharCode(0x200b));
  }, 15000);

  it("refuses to spawn a command that isn't on the allowlist", async () => {
    await expect(
      createMcpToolset("test", { command: "node", args: [echoFixturePath] }, { allowedCommandsCsv: "" }),
    ).rejects.toThrow();
  }, 15000);
});

/** `McpClient` opens a fresh `Client`/session per `connect()` call (see `client.ts`'s doc
 *  comment) — `listTools()` and each `callTool()` are independent sessions, not one long-lived
 *  connection. A real Streamable-HTTP server needs a session-id-keyed map of transports to
 *  support that (a single shared transport's underlying `McpServer` instance only accepts one
 *  "initialize" ever; the SDK's own "stateless" mode instead expects a brand-new transport for
 *  literally every HTTP request, which doesn't model a session at all). This mirrors what a real
 *  production Streamable-HTTP server does. */
function createSessionedMcpHttpServer(build: (server: McpServer) => void): Server {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return createServer((req, res) => {
    void (async () => {
      const headerSessionId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
      const body = await readJsonBody(req);

      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        const mcpServer = new McpServer({ name: "http-fixture", version: "1.0.0" });
        build(mcpServer);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        await mcpServer.connect(asTransport(transport));
      }
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
}

describe("createMcpToolset — streamable HTTP transport", () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    httpServer?.close();
    httpServer = undefined;
  });

  it("discovers and invokes a tool over a real local HTTP server", async () => {
    httpServer = createSessionedMcpHttpServer((mcpServer) => {
      mcpServer.registerTool("ping", { description: "Replies pong.", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
    });
    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve((httpServer!.address() as { port: number }).port));
    });

    // Discovery (listTools) and invocation (callTool) are two independent sessions against the
    // same server — exercising exactly the session-map behavior described above.
    const registrations = await createMcpToolset("remote", { url: `http://127.0.0.1:${port}/mcp`, type: "http" });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.toolset).toBe("mcp:remote");

    const result = await registrations[0]!.handler({}, { activationKey: "k" });
    expect(result).toContain("pong");
  }, 15000);
});
