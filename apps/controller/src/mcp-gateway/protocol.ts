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
import { McpProtocol, McpSchema } from "effect/ai";
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

/** The request headers a check reads, by lower-case name. */
export type HeaderMap = Readonly<Record<string, string | undefined>>;

/**
 * Returns whether a message that names no stateful MCP session is meant for
 * the stateless era: it names the revision in its `_meta` or in its
 * `MCP-Protocol-Version` header.
 */
export const isStatelessMessage = (headers: HeaderMap, params: JsonObject): boolean =>
  readStatelessRevision(params) !== undefined ||
  headers["mcp-protocol-version"] === STATELESS_REVISION;

/** An HTTP-level refusal of a request whose headers contradict its body or its MCP session. */
export interface RequestRefusal {
  readonly status: number;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const buildHeaderMismatch = (message: string): RequestRefusal => ({
  status: 400,
  code: McpSchema.HEADER_MISMATCH_ERROR_CODE,
  message,
});

const buildUnsupportedHeaderRevision = (
  requested: string,
  supported: ReadonlyArray<string>,
): RequestRefusal => ({
  status: 400,
  code: McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  message: `Unsupported protocol version: ${requested}`,
  data: { supported },
});

/**
 * Checks the `MCP-Protocol-Version` header of a message that names a stateful
 * MCP session against the revision that session negotiated. Returns the
 * refusal, or `undefined` when the message may go on. A message with no header
 * is accepted, as the transport specification asks. A header is refused when
 * it names no revision the gateway offers, and when it differs from the
 * negotiated revision, whichever revision that is.
 */
export const checkSessionVersionHeader = (
  header: string | undefined,
  negotiated: string,
): RequestRefusal | undefined => {
  if (header === undefined) return undefined;
  if (header !== STATELESS_REVISION && !STATEFUL_REVISIONS.includes(header)) {
    return buildUnsupportedHeaderRevision(header, [...STATEFUL_REVISIONS, STATELESS_REVISION]);
  }
  if (header !== negotiated) {
    return buildHeaderMismatch(
      `MCP-Protocol-Version header '${header}' does not match negotiated protocol version '${negotiated}'`,
    );
  }
  return undefined;
};

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

/**
 * Decodes the value of an `Mcp-Name` header: printable ASCII as it is, or any
 * text wrapped in `=?base64?...?=`. Returns `undefined` for a value that is
 * neither.
 */
const decodeNameHeader = (value: string): string | undefined => {
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return /^[\t\x20-\x7e]*$/.test(value) ? value : undefined;
  }
  try {
    const bytes = Buffer.from(
      value.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length),
      "base64",
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks that a stateless message's HTTP headers agree with its JSON-RPC
 * payload, as Effect's own transport does for `2026-07-28`. Returns the
 * refusal, or `undefined` when they agree.
 *
 * - `MCP-Protocol-Version` is required, must equal the revision in `_meta`,
 *   and must be the revision the gateway offers;
 * - `_meta` must carry the revision and the client's capabilities;
 * - `Mcp-Method` must equal the method, and for `tools/call`, `Mcp-Name` must
 *   equal the tool's name.
 *
 * A `notifications/cancelled` is exempt from the `_meta` rules, because the
 * protocol lets it carry no `_meta` of its own.
 */
export const checkStatelessMetadata = (
  headers: HeaderMap,
  method: string,
  params: JsonObject,
): RequestRefusal | undefined => {
  const version = headers["mcp-protocol-version"];
  if (version === undefined) return buildHeaderMismatch("MCP-Protocol-Version header is required");
  const isCancellation = method === "notifications/cancelled";
  const meta = isObject(params["_meta"]) ? params["_meta"] : undefined;
  const claim = meta?.[REVISION_META_KEY];
  if (!isCancellation && typeof claim !== "string") {
    return {
      status: 400,
      code: McpSchema.INVALID_PARAMS_ERROR_CODE,
      message: "Required request metadata is missing",
    };
  }
  if ((!isCancellation || claim !== undefined) && claim !== version) {
    return buildHeaderMismatch("MCP-Protocol-Version header does not match request metadata");
  }
  if (!isCancellation && !isObject(meta?.[CLIENT_CAPABILITIES_META_KEY])) {
    return {
      status: 400,
      code: McpSchema.INVALID_PARAMS_ERROR_CODE,
      message: `${CLIENT_CAPABILITIES_META_KEY} request metadata is required`,
    };
  }
  if (version !== STATELESS_REVISION) {
    return buildUnsupportedHeaderRevision(version, [STATELESS_REVISION]);
  }
  if (headers["mcp-method"] !== method) {
    return buildHeaderMismatch("Mcp-Method header does not match request method");
  }
  if (method === "tools/call") {
    const name = params["name"];
    const header = headers["mcp-name"];
    if (typeof name !== "string" || header === undefined || decodeNameHeader(header) !== name) {
      return buildHeaderMismatch("Mcp-Name header does not match request parameters");
    }
  }
  return undefined;
};

/** The notifications a `subscriptions/listen` request asks for that the gateway can send. */
export interface HonoredNotifications {
  readonly toolsListChanged: boolean;
}

// The protocol adapter erases the type of its requests, so the payload schema is read through a narrow type.
const listenRpc = McpProtocol.v2026_07_28.clientRpcs.requests.get("subscriptions/listen") as
  | { readonly payloadSchema: Schema.Decoder<unknown> }
  | undefined;
const decodeListenParams = Schema.decodeUnknownOption(listenRpc!.payloadSchema);

/**
 * Decodes the parameters of a `subscriptions/listen` request with the schema
 * of the pinned `2026-07-28` protocol. Returns what the gateway will send:
 * `list_changed` of the tools, when the request asks for it. The other
 * notifications a request may ask for (prompts, resources) are not served, so
 * they are left out. Returns `undefined` for parameters the schema refuses.
 */
export const readListenRequest = (params: JsonObject): HonoredNotifications | undefined => {
  const decoded = decodeListenParams(params);
  if (Option.isNone(decoded)) return undefined;
  const { notifications } = decoded.value as {
    readonly notifications: { readonly toolsListChanged?: boolean };
  };
  return { toolsListChanged: notifications.toolsListChanged === true };
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

/** Builds the JSON-RPC answer for a request that `checkStatelessMetadata` or `checkSessionVersionHeader` refused. */
export const buildRefusalBody = (id: RequestId | null, refusal: RequestRefusal) =>
  buildRpcError(id, refusal.code, refusal.message, refusal.data);

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
export const buildToolCallResult = (
  era: "stateful" | "stateless",
  result: McpSchema.CallToolResult,
) => (era === "stateless" ? { ...STATELESS_RESULT, ...result } : result);

/** The message `list_changed` sends on a stateful stream. */
export const buildListChangedNotification = () => ({
  jsonrpc: "2.0" as const,
  method: "notifications/tools/list_changed",
});

/** The message `subscriptions/listen` sends first: the notifications it will send. */
export const buildSubscriptionAcknowledgement = (
  listenId: RequestId,
  honored: HonoredNotifications,
) => ({
  jsonrpc: "2.0" as const,
  method: "notifications/subscriptions/acknowledged",
  params: {
    _meta: { [SUBSCRIPTION_META_KEY]: listenId },
    notifications: honored.toolsListChanged ? { toolsListChanged: true } : {},
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
