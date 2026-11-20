/**
 * A probe: does a harness pick up a tool that appears while a session runs?
 *
 * It is a small MCP server over Streamable HTTP, in the older style every
 * harness client still speaks (an `initialize` handshake, a session id, and a
 * GET stream for messages from the server). It starts with one tool. Some
 * seconds after a client initializes, a second tool appears, `secret_word`,
 * and the server sends `notifications/tools/list_changed` on every open GET
 * stream. That is what the gateway would do when the user adds a server to a
 * thread that is running.
 *
 * Every request is written to the log, so a run shows whether the harness
 * opened the stream, and whether it asked for the tool list again.
 *
 * Usage: bun list-changed-probe.ts <port> <log file> [seconds before the tool appears]
 */
import { appendFileSync } from "node:fs";

const [portText, logFile, delayText] = process.argv.slice(2);
if (portText === undefined || logFile === undefined) {
  throw new Error("usage: list-changed-probe.ts <port> <log file> [seconds]");
}
const GROW_AFTER_MS = Number(delayText ?? "12") * 1000;
export const SECRET_WORD = "marmalade-4821";

const started = Date.now();
const log = (line: string): void => {
  appendFileSync(logFile, `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}\n`);
};

let grown = false;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

const BASE_TOOL = {
  name: "server_time",
  description: "Returns the server's clock.",
  inputSchema: { type: "object", properties: {} },
};
const LATE_TOOL = {
  name: "secret_word",
  description: "Returns the secret word.",
  inputSchema: { type: "object", properties: {} },
};

const grow = (): void => {
  if (grown) return;
  grown = true;
  log(`the tool appears; ${String(streams.size)} open stream(s) get tools/list_changed`);
  const message = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
  for (const stream of streams) stream.enqueue(encoder.encode(message));
};

interface Request {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const answer = (request: Request): unknown => {
  switch (request.method) {
    case "initialize":
      setTimeout(grow, GROW_AFTER_MS);
      return {
        protocolVersion: request.params?.["protocolVersion"] ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "hercule", version: "0.0.0-probe" },
      };
    case "tools/list":
      return { tools: grown ? [BASE_TOOL, LATE_TOOL] : [BASE_TOOL] };
    case "tools/call": {
      const name = String(request.params?.["name"]);
      if (name === "secret_word" && grown) return { content: [{ type: "text", text: SECRET_WORD }] };
      if (name === "server_time") return { content: [{ type: "text", text: new Date().toISOString() }] };
      return { content: [{ type: "text", text: `No tool is called ${name}.` }], isError: true };
    }
    case "ping":
      return {};
    default:
      return undefined;
  }
};

Bun.serve({
  port: Number(portText),
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(incoming) {
    if (incoming.method === "GET") {
      log("GET: the client opens the stream for messages from the server");
      let own: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          own = controller;
          streams.add(controller);
          controller.enqueue(encoder.encode(": open\n\n"));
        },
        cancel() {
          if (own !== undefined) streams.delete(own);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    if (incoming.method === "DELETE") {
      log("DELETE: the client ends the session");
      return new Response(null, { status: 200 });
    }
    const request = (await incoming.json()) as Request;
    const detail = request.method === "tools/call" ? ` ${String(request.params?.["name"])}` : "";
    log(`POST ${request.method}${detail}${request.method === "tools/list" ? (grown ? " (two tools)" : " (one tool)") : ""}`);
    // A message without an id is a notification, which gets no answer.
    if (request.id === undefined) return new Response(null, { status: 202 });
    const result = answer(request);
    const payload =
      result === undefined
        ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no method ${request.method}` } }
        : { jsonrpc: "2.0", id: request.id, result };
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "mcp-session-id": "probe-session" },
    });
  },
});
log(`listening; the second tool appears ${String(GROW_AFTER_MS / 1000)}s after a client initializes`);
