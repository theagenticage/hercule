/**
 * A recording proxy for tests of the MCP Gateway with a real harness. It sits
 * between the harness and the controller, forwards every request unchanged, and
 * keeps what the gateway received: JSON-RPC methods, revisions, MCP session ids,
 * and the messages the gateway sent on each event stream.
 */

/** One request the gateway received through the proxy, and how it answered. */
export interface ObservedRequest {
  readonly httpMethod: string;
  /** The JSON-RPC method of a POST, and `-` for a request with no body. */
  readonly rpcMethod: string;
  /** The tool a `tools/call` names, and `null` for every other request. */
  readonly tool: string | null;
  /** The revision an `initialize` asks for, and `null` for every other request. */
  readonly initializeRevision: string | null;
  readonly protocolVersion: string | null;
  /** The `Mcp-Method` header of the 2026-07-28 era. */
  readonly mcpMethod: string | null;
  /** The `Mcp-Session-Id` the request carried. */
  readonly sessionId: string | null;
  status: number | undefined;
  /** The `Mcp-Session-Id` the gateway answered with: set by an `initialize` only. */
  answeredSessionId: string | null;
  /** The JSON-RPC methods of the messages the gateway sent on this response's event stream, in order. */
  readonly streamed: Array<string>;
}

export interface RecordingProxy {
  readonly url: string;
  readonly seen: ReadonlyArray<ObservedRequest>;
  /**
   * Starts or ends holding back `notifications/tools/list_changed` from the
   * harness. The gateway still sends it and the proxy still records it, but the
   * harness never receives it. This stands for a notification that is still on
   * its way when the harness acts on the list it holds.
   */
  readonly withholdListChanged: (withhold: boolean) => void;
  readonly stop: () => Promise<void>;
}

/** Reads the `data:` lines of an event stream and calls `onMessage` with each JSON-RPC message. */
const readEventStream = async (
  body: ReadableStream<Uint8Array>,
  onMessage: (message: { readonly method?: string }) => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            onMessage(JSON.parse(line.slice("data: ".length)) as { readonly method?: string });
          }
        }
      }
    }
  } catch {
    // The connection ended, which is how every stream ends.
  }
};

/**
 * Builds a stream transform that passes an event stream through unchanged,
 * except that it drops every event that carries `notifications/tools/list_changed`
 * while `isWithholding` returns true. It cuts the stream into events (blocks
 * that end in an empty line), so an event is never split.
 */
const buildListChangedFilter = (
  isWithholding: () => boolean,
): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
        const block = pending.slice(0, end + 2);
        pending = pending.slice(end + 2);
        if (!(isWithholding() && block.includes('"notifications/tools/list_changed"'))) {
          controller.enqueue(encoder.encode(block));
        }
      }
    },
    flush(controller) {
      if (pending !== "") controller.enqueue(encoder.encode(pending));
    },
  });
};

/**
 * Starts a proxy in front of the controller that forwards every request
 * unchanged and records it. With `answerDiscoverLikeOlderServer`, it answers
 * `server/discover` itself the way a server built on the official TypeScript
 * SDK does (HTTP 400, JSON-RPC -32000), so the CLI falls back to `initialize`.
 * The gateway serves both eras, so this is the only way to see the CLI on the
 * older one.
 */
export const startRecordingProxy = (
  target: string,
  options: { readonly answerDiscoverLikeOlderServer: boolean },
): RecordingProxy => {
  const seen: Array<ObservedRequest> = [];
  let withholding = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A stream that stays quiet is normal here; the default would cut it after ten seconds.
    idleTimeout: 0,
    async fetch(request) {
      const address = new URL(request.url);
      const text = request.method === "POST" ? await request.text() : undefined;
      const message =
        text === undefined
          ? undefined
          : (JSON.parse(text) as {
              method?: string;
              params?: { name?: string; protocolVersion?: string };
            });
      const observed: ObservedRequest = {
        httpMethod: request.method,
        rpcMethod: message === undefined ? "-" : (message.method ?? "?"),
        tool: message?.method === "tools/call" ? (message.params?.name ?? null) : null,
        initializeRevision:
          message?.method === "initialize" ? (message.params?.protocolVersion ?? null) : null,
        protocolVersion: request.headers.get("mcp-protocol-version"),
        mcpMethod: request.headers.get("mcp-method"),
        sessionId: request.headers.get("mcp-session-id"),
        status: undefined,
        answeredSessionId: null,
        streamed: [],
      };
      seen.push(observed);
      if (options.answerDiscoverLikeOlderServer && observed.rpcMethod === "server/discover") {
        observed.status = 400;
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request" } },
          { status: 400 },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const answer = await fetch(`${target}${address.pathname}${address.search}`, {
        method: request.method,
        headers,
        ...(text === undefined ? {} : { body: text }),
        signal: request.signal,
      });
      observed.status = answer.status;
      observed.answeredSessionId = answer.headers.get("mcp-session-id");
      const isStream = (answer.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!isStream || answer.body === null) {
        return new Response(answer.body, { status: answer.status, headers: answer.headers });
      }
      const [toClient, toRecord] = answer.body.tee();
      void readEventStream(toRecord, (message) => {
        observed.streamed.push(message.method ?? "(response)");
      });
      return new Response(toClient.pipeThrough(buildListChangedFilter(() => withholding)), {
        status: answer.status,
        headers: answer.headers,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    seen,
    withholdListChanged: (withhold) => {
      withholding = withhold;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
};

/** Describes one observed request as `METHOD rpc-method revision session status`, for a readable assertion. */
export const describeRequest = (one: ObservedRequest): string =>
  [
    one.httpMethod,
    one.rpcMethod,
    one.protocolVersion ?? "no-revision",
    one.sessionId === null ? "no-session" : "session",
    String(one.status),
  ].join(" ");

/** Returns the observed requests with this JSON-RPC method, or the GET streams for `GET`. */
export const requestsOf = (
  seen: ReadonlyArray<ObservedRequest>,
  rpcMethod: string,
): ReadonlyArray<ObservedRequest> =>
  seen.filter((one) =>
    rpcMethod === "GET" ? one.httpMethod === "GET" : one.rpcMethod === rpcMethod,
  );

/** Counts the `notifications/tools/list_changed` messages the gateway sent on the streams of `requests`. */
export const countListChanged = (requests: ReadonlyArray<ObservedRequest>): number =>
  requests.reduce(
    (count, one) =>
      count + one.streamed.filter((method) => method === "notifications/tools/list_changed").length,
    0,
  );

/** Waits until the gateway has received nothing from the CLI for `quietMs`. */
export const waitUntilQuiet = async (proxy: RecordingProxy, quietMs = 2_000): Promise<void> => {
  let count = -1;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (proxy.seen.length !== count) {
      count = proxy.seen.length;
      since = Date.now();
    }
  }
};
