import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { validateStdioServerConfig } from "./security.js";
import { sanitizeMcpToolResult } from "./sanitize.js";

/** The SDK's `StreamableHTTPClientTransport`/`SSEClientTransport` declare a `sessionId` getter
 *  typed `string | undefined` against a `Transport.sessionId?: string` interface field — under
 *  this repo's `exactOptionalPropertyTypes`, those aren't the same type (an optional property
 *  may be absent, but if present must be exactly `string`), so `tsc` rejects passing either
 *  class where `Transport` is expected. Both classes are otherwise structurally complete; this
 *  narrow cast exists only to route around that one mismatched declaration. */
function asTransport(transport: object): Transport {
  return transport as unknown as Transport;
}

/** A local subprocess speaking MCP over stdin/stdout. */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * A remote MCP server reached over HTTP. `type` is optional — when omitted, connection tries
 * Streamable HTTP first and falls back to SSE, mirroring how real MCP clients (and Flowise's own
 * MCP toolkit) handle servers whose transport the operator didn't bother specifying. Set it
 * explicitly only if a server errors ambiguously on the HTTP attempt.
 */
export interface McpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
  type?: "http" | "sse";
}

export type McpServerConfig = McpStdioConfig | McpRemoteConfig;

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

function isStdioConfig(config: McpServerConfig): config is McpStdioConfig {
  return "command" in config;
}

const CLIENT_INFO = { name: "flowlathe", version: "1.0.0" };

/**
 * A thin wrapper over the MCP SDK's `Client` that reconnects for every call rather than holding
 * a persistent connection — the simplest correct behavior for a v1: no reconnect-on-crash logic
 * needed for a long-lived stdio child process or an idle HTTP/SSE session, at the cost of one
 * extra round-trip per tool invocation. Mirrors Flowise's `MCPToolkit`, which does the same.
 */
export class McpClient {
  constructor(
    private readonly config: McpServerConfig,
    private readonly opts: { allowedCommandsCsv?: string } = {},
  ) {}

  private async connectStdio(config: McpStdioConfig): Promise<Client> {
    validateStdioServerConfig(config, this.opts.allowedCommandsCsv);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      // Compatible with an overridden PATH — matches Flowise's MCPToolkit.
      env: { ...(config.env ?? {}), PATH: process.env["PATH"] ?? "" },
    });
    await client.connect(transport);
    return client;
  }

  private async connectRemote(config: McpRemoteConfig): Promise<Client> {
    const url = new URL(config.url);
    const requestInit = config.headers ? { headers: config.headers } : undefined;

    if (config.type === "sse") {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await client.connect(asTransport(new SSEClientTransport(url, requestInit ? { requestInit } : undefined)));
      return client;
    }

    const httpClient = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await httpClient.connect(asTransport(new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)));
      return httpClient;
    } catch (err) {
      if (config.type === "http") throw err; // explicit http: don't silently fall back
      const sseClient = new Client(CLIENT_INFO, { capabilities: {} });
      await sseClient.connect(asTransport(new SSEClientTransport(url, requestInit ? { requestInit } : undefined)));
      return sseClient;
    }
  }

  private async connect(): Promise<Client> {
    return isStdioConfig(this.config) ? this.connectStdio(this.config) : this.connectRemote(this.config);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const client = await this.connect();
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => {
        const inputSchema: McpToolDescriptor["inputSchema"] = { type: "object" };
        if (t.inputSchema.properties) inputSchema.properties = t.inputSchema.properties;
        if (t.inputSchema.required) inputSchema.required = t.inputSchema.required;
        return { name: t.name, description: t.description ?? t.name, inputSchema };
      });
    } finally {
      await client.close();
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      // `result.content` is server-controlled and may include base64 image data — sanitized and
      // bounded here (in the client, not the toolset handler) so any future caller of this class
      // gets the same protection. See CLAUDE.md/PLAN-SANITIZATION-BOUNDARY.md: sanitizing a
      // server's tool descriptions while leaving its results raw is close to meaningless.
      return sanitizeMcpToolResult(JSON.stringify(result.content));
    } finally {
      await client.close();
    }
  }
}
