/**
 * The MCP wire format the gateway speaks towards a session's harness (spec 21
 * section 3.2): JSON-RPC messages, the two protocol eras, and server-sent
 * events. Everything here is pure.
 *
 * Effect's `McpServer` cannot serve a list per session (spec 21 section
 * 3.11), so the gateway writes this side itself, on the message schemas of
 * Effect's `McpSchema`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { VERSION } from "@hercule/home/version";

/** The largest POST body the gateway reads, in bytes. A tool call's arguments never need more than 1 MiB. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** The revisions of the stateful era: `initialize`, `Mcp-Session-Id`, the GET stream and DELETE. */
const STATEFUL_REVISIONS: ReadonlyArray<string> = ["2025-03-26", "2025-06-18", "2025-11-25"];

/** The revision a client gets when it asks for one the gateway does not offer. */
const NEWEST_STATEFUL_REVISION = "2025-11-25";

/** The one revision of the stateless era: `server/discover` and `subscriptions/listen`. */
export const STATELESS_REVISION = "2026-07-28";

/** The request header that names a stateful MCP session. */
export const SESSION_ID_HEADER = "mcp-session-id";

/** The key in a request's `_meta` that carries the stateless era's revision. */
const REVISION_META_KEY = "io.modelcontextprotocol/protocolVersion";

/** The key in a notification's `_meta` that names the `subscriptions/listen` request it belongs to. */
const SUBSCRIPTION_META_KEY = "io.modelcontextprotocol/subscriptionId";

/** The JSON-RPC error code for a request the client cancelled. */
export const REQUEST_CANCELLED_ERROR_CODE = -32800;

export type JsonObject = Readonly<Record<string, unknown>>;

/** A JSON-RPC id. */
export type RequestId = string | number;

/** One message a client sent, sorted by what the gateway must do with it. */
export type IncomingMessage =
  | {
      readonly _tag: "request";
      readonly id: RequestId;
      readonly method: string;
      readonly params: JsonObject;
    }
  | { readonly _tag: "notification"; readonly method: string; readonly params: JsonObject }
  /** A client's answer to a request of a server. The gateway sends none, so it ignores these. */
  | { readonly _tag: "response" }
  | { readonly _tag: "batch" }
  | { readonly _tag: "invalid" };

const decodeEnvelope = Schema.decodeUnknownOption(McpSchema.JsonRpcMessage);

/**
 * Sorts a parsed JSON body into a request, a notification, a response, a
 * batch (a JSON array, which the gateway refuses) or an invalid message.
 */
export const classifyMessage = (json: unknown): IncomingMessage => {
  if (Array.isArray(json)) return { _tag: "batch" };
  const decoded = decodeEnvelope(json);
  if (Option.isNone(decoded)) return { _tag: "invalid" };
  const message = decoded.value;
  if ("method" in message && "id" in message) {
    return {
      _tag: "request",
      id: message.id,
      method: message.method,
      params: message.params ?? {},
    };
  }
  if ("method" in message) {
    return { _tag: "notification", method: message.method, params: message.params ?? {} };
  }
  return { _tag: "response" };
};

/**
 * Returns the revision a stateful `initialize` gets: the one it asked for when
 * the gateway offers it, else the newest the gateway offers.
 */
export const negotiateStatefulRevision = (requested: unknown): string =>
  typeof requested === "string" && STATEFUL_REVISIONS.includes(requested)
    ? requested
    : NEWEST_STATEFUL_REVISION;

/**
 * Returns the revision a request names in its `_meta`, which only the
 * stateless era does, or `undefined` when it names none.
 */
export const readStatelessRevision = (params: JsonObject): string | undefined => {
  const meta = params["_meta"];
  if (typeof meta !== "object" || meta === null) return undefined;
  const revision = (meta as JsonObject)[REVISION_META_KEY];
  return typeof revision === "string" ? revision : undefined;
};

/** Builds a JSON-RPC answer carrying a result. */
export const buildRpcResult = (id: RequestId, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

/** Builds a JSON-RPC answer carrying an error. `id` is `null` when the request had none that could be read. */
export const buildRpcError = (
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** The error of a method the gateway does not serve. */
export const buildMethodNotFound = (id: RequestId, method: string) =>
  buildRpcError(id, McpSchema.METHOD_NOT_FOUND_ERROR_CODE, `Method not found: ${method}`);

/** The error of a revision the stateless era does not offer, with the revision it does. */
export const buildUnsupportedRevision = (id: RequestId | null, requested: string) =>
  buildRpcError(
    id,
    McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
    `Unsupported protocol version: ${requested}`,
    { supported: [STATELESS_REVISION] },
  );

const SERVER_INFO = { name: "hercule", version: VERSION } as const;

/** The only capability the gateway has: tools, whose list can change. */
const CAPABILITIES = { tools: { listChanged: true } } as const;

/** Builds the result of a stateful `initialize`. */
export const buildInitializeResult = (revision: string, instructions: string) => ({
  protocolVersion: revision,
  capabilities: CAPABILITIES,
  serverInfo: SERVER_INFO,
  instructions,
});

/** The members every result of the stateless era carries. */
const STATELESS_RESULT = { resultType: "complete" as const };

/**
 * The members of a stateless result that a client may cache. A tool list
 * changes with the session's list, so nothing is cached.
 */
const UNCACHEABLE = { ttlMs: 0, cacheScope: "private" as const };

/** Builds the result of `server/discover`. */
export const buildDiscoverResult = (instructions: string) => ({
  ...STATELESS_RESULT,
  ...UNCACHEABLE,
  supportedVersions: [STATELESS_REVISION],
  capabilities: CAPABILITIES,
  instructions,
  _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
});

/** Builds the result of `tools/list` for one era. The gateway sends one page, so there is no cursor. */
export const buildToolsListResult = (
  era: "stateful" | "stateless",
  tools: ReadonlyArray<unknown>,
) => (era === "stateless" ? { ...STATELESS_RESULT, ...UNCACHEABLE, tools } : { tools });

/** Adds the stateless era's `resultType` to a `tools/call` result. */
export const buildToolCallResult = (era: "stateful" | "stateless", result: unknown) =>
  era === "stateless" ? { ...STATELESS_RESULT, ...(result as JsonObject) } : result;

/** The message `list_changed` sends on a stateful stream. */
export const buildListChangedNotification = () => ({
  jsonrpc: "2.0" as const,
  method: "notifications/tools/list_changed",
});

/** The message `subscriptions/listen` sends first: the notifications it will send. */
export const buildSubscriptionAcknowledgement = (listenId: RequestId) => ({
  jsonrpc: "2.0" as const,
  method: "notifications/subscriptions/acknowledged",
  params: {
    _meta: { [SUBSCRIPTION_META_KEY]: listenId },
    notifications: { toolsListChanged: true },
  },
});

/** The message `list_changed` sends on a `subscriptions/listen` response. */
export const buildSubscribedListChangedNotification = (listenId: RequestId) => ({
  jsonrpc: "2.0" as const,
  method: "notifications/tools/list_changed",
  params: { _meta: { [SUBSCRIPTION_META_KEY]: listenId } },
});

/** The message that ends a `subscriptions/listen` response. */
export const buildListenResult = (listenId: RequestId) => ({
  ...STATELESS_RESULT,
  _meta: { [SUBSCRIPTION_META_KEY]: listenId, "io.modelcontextprotocol/serverInfo": SERVER_INFO },
});

const encoder = new TextEncoder();

/** Encodes one JSON-RPC message as a server-sent event. */
export const encodeServerSentEvent = (message: unknown): Uint8Array =>
  encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);

/**
 * A server-sent comment. Sent every 30 seconds so that neither Bun's idle
 * timeout (255 seconds) nor a proxy closes a stream that has nothing to say.
 */
export const SERVER_SENT_KEEPALIVE: Uint8Array = encoder.encode(": keepalive\n\n");
