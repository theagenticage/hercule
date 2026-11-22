/**
 * A fake MCP server for tests that run a real harness against the MCP Gateway.
 *
 * It speaks the older Streamable HTTP style that Codex and Claude Code still
 * use: an `initialize` request that answers with an `Mcp-Session-Id` header,
 * a GET stream for notifications, and one POST per JSON-RPC request. It offers
 * three tools, named the way the gateway names them (`<server>__<tool>`), and
 * records every request it receives, so a test can check what the harness
 * sent and that a call reached the server (or did not).
 */
import { PNG_BYTES } from "./testing";

/** The tool the fake offers with no annotations. */
export const SEARCH_ISSUES_TOOL = "sentry__search_issues";

/** The tool the fake offers with the `readOnlyHint` annotation. */
export const WHOAMI_TOOL = "sentry__whoami";

/** The tool the fake offers whose result holds an image, `PNG_BYTES`, as an MCP image block. */
export const SNAPSHOT_IMAGE_TOOL = "sentry__get_snapshot_image";

/** One request the fake received. `tool` is set on `tools/call` only. */
export interface FakeMcpRequest {
  readonly method: string;
  readonly authorization: string | null;
  readonly tool?: string;
}

export interface FakeMcpServer {
  /** The address a harness is given as the MCP server's URL. */
  readonly url: string;
  /** Every POST received so far, in order. A GET stream is not listed. */
  readonly requests: ReadonlyArray<FakeMcpRequest>;
  /** Returns the names of the tools that were called, in order. */
  readonly listCalledTools: () => ReadonlyArray<string>;
  /** Stops the server and closes its open streams. */
  readonly stop: () => void;
}

const TOOLS = [
  {
    name: SEARCH_ISSUES_TOOL,
    description: "Searches Sentry issues.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: WHOAMI_TOOL,
    description: "Returns the Sentry user the gateway acts as.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: SNAPSHOT_IMAGE_TOOL,
    description: "Returns a snapshot of an issue as an image.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Starts the fake on a free port of the loopback interface. */
export const startFakeMcpServer = (): FakeMcpServer => {
  const requests: Array<FakeMcpRequest> = [];
  const sessions = new Set<string>();
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The GET stream stays open and idle. Bun closes an idle connection after
    // 10 seconds by default, which would make the harness reconnect.
    idleTimeout: 0,
    async fetch(request) {
      const authorization = request.headers.get("authorization");
      const sessionId = request.headers.get("mcp-session-id");
      if (request.method === "GET") {
        if (sessionId === null || !sessions.has(sessionId)) {
          return new Response("session not found", { status: 404 });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(encoder.encode(": open\n\n")),
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "DELETE") {
        if (sessionId !== null) sessions.delete(sessionId);
        return new Response(null, { status: 200 });
      }
      const body = (await request.json()) as {
        readonly id?: number | string;
        readonly method: string;
        readonly params?: { readonly name?: string; readonly protocolVersion?: string };
      };
      requests.push({
        method: body.method,
        authorization,
        ...(body.method === "tools/call" ? { tool: String(body.params?.name) } : {}),
      });
      // A notification has no id and no answer.
      if (body.id === undefined) return new Response(null, { status: 202 });
      const headers: Record<string, string> = { "content-type": "application/json" };
      let result: unknown;
      switch (body.method) {
        case "initialize": {
          const created = crypto.randomUUID();
          sessions.add(created);
          headers["mcp-session-id"] = created;
          result = {
            protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fake-gateway", version: "0.0.0" },
          };
          break;
        }
        case "tools/list":
          result = { tools: TOOLS };
          break;
        case "tools/call": {
          const name = String(body.params?.name);
          result = {
            content: [
              { type: "text", text: `result of ${name}` },
              ...(name === SNAPSHOT_IMAGE_TOOL
                ? [{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" }]
                : []),
            ],
          };
          break;
        }
        default:
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: `no method ${body.method}` },
            },
            { headers },
          );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    listCalledTools: () =>
      requests.flatMap((request) => (request.tool === undefined ? [] : [request.tool])),
    stop: () => void server.stop(true),
  };
};
