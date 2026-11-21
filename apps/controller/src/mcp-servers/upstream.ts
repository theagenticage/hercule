/**
 * Opens an MCP client to a server outside the controller, for a check or, in a
 * later step, for the gateway's calls (spec 21 sections 3.10, 5.1 and 5.6).
 *
 * The rules this file enforces for every request that leaves the controller:
 *
 * - The URL and headers come only from the endpoint's `buildRequest`
 *   (`access.ts`), called with the credentials the request is about to carry,
 *   after the controller is known to be serving. The URL must be `http` or
 *   `https`, on the endpoint's origin, with no user name or password.
 *   Otherwise nothing is sent.
 * - A redirect is never followed, so a credential never reaches another
 *   origin. A 3xx answer is an error.
 * - Nothing is sent while the controller is frozen or sealed: a background
 *   caller waits for the thaw. A caller that gives a `PrepareSend` (the
 *   gateway's calls and the opening of its sessions) gets a failure at once,
 *   for every request that starts an exchange: `PrepareSend` reads the current
 *   credentials and runs the caller's checks (is the controller serving, may
 *   the call still be made, is the destination unchanged) right before the
 *   request goes out, so a wait for credentials never lets an old check
 *   stand. A request that only continues an exchange that was already sent,
 *   such as the reply to a request of the server, is let through, so that
 *   exchange settles. It reads the credentials stored now, and never starts a
 *   refresh of them: a refresh is a new request to the provider, and no call
 *   has the right to make one for an exchange that already went out.
 * - The HTTP client creates no trace spans, so no URL or error text reaches a
 *   trace, and no trace headers go to the outside server.
 * - No failure carries the server's answer, its headers, the request or a
 *   credential: each failure has a fixed message.
 *
 * The opened session lists the server's tools and calls one of them. Both
 * remove from what the server answered every credential value the session
 * sent, so a server that echoes its request never hands the Connection's
 * token on. A call also decides which of its failures may be tried again
 * (see `callTool` of `OpenedUpstream`).
 *
 * The file also holds what every caller does with an upstream failure:
 * `runWithCredentials` gets the server's credentials and refreshes them once
 * when the server refuses them, and `buildStatusFromFailure` says what status
 * a failure gives the server.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { McpClient, McpClientError, McpProtocol, McpSchema } from "effect/ai";
import { VERSION } from "@hercule/home/version";
import type { RefreshGuard } from "../connections";
import { DRAIN_TIMEOUT, PromotionState } from "../promotion";
import {
  ServerCredentialsCannotRefresh,
  type ServerCredentials,
  type ServerCredentialsUnavailable,
  type UpstreamCredentials,
  type UpstreamEndpoint,
} from "./access";
import { removeCredentialValues } from "./credential-values";
import type { StoredMcpTool } from "./repository";

/**
 * How long one whole piece of work against an outside server may take: a
 * call or a check, with the opening of the upstream MCP session, the refresh
 * and the retry. It ends 15 seconds before a freeze gives up waiting for
 * running work (`DRAIN_TIMEOUT`), so work admitted just before a freeze never
 * fails the freeze.
 */
export const UPSTREAM_WORK_DEADLINE = Duration.subtract(DRAIN_TIMEOUT, Duration.seconds(15));

/** The largest message a server may send, or the controller may send: one JSON answer or one SSE event. */
export const MAX_UPSTREAM_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * The most the definitions of one server's tools may take, as JSON. A listing
 * is measured twice: while it is read, with each tool as the client keeps it
 * (`limitToolListing`), and again as it is stored (the check).
 */
export const MAX_TOOL_DEFINITIONS_BYTES = 4 * 1024 * 1024;

/** The most pages of `tools/list` one listing may read. */
const MAX_TOOL_LIST_PAGES = 100;

/** What a check says when a server's tool definitions are over `MAX_TOOL_DEFINITIONS_BYTES`. */
export const TOOL_LIST_TOO_LARGE = "The server's tool list is larger than 4 MiB";

/** Returns the tool as a decoded `McpSchema.Tool`, or `None` when it does not fit that schema. */
const decodeTool = Schema.decodeUnknownOption(McpSchema.Tool);
const decodeCallResult = Schema.decodeUnknownOption(McpSchema.CallToolResult);

/**
 * Copies a tool as plain JSON, keeping the whole definition so the gateway can
 * serve it. `description` is `""` when the server gave none. The fields the
 * controller does not store (`icons`, `_meta`) are left out.
 */
export const toStoredTool = (tool: McpSchema.Tool): StoredMcpTool =>
  JSON.parse(
    JSON.stringify({
      name: tool.name,
      title: tool.title,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  ) as StoredMcpTool;

/**
 * What one listing of a server's tools has read so far. `exceeded` is the
 * failure that ended the listing when a limit was passed, and `undefined`
 * while none was.
 */
interface ToolListing {
  pages: number;
  bytes: number;
  exceeded: UpstreamError | undefined;
}

/**
 * Why an upstream call failed:
 *
 * - `unauthorized`: the server answered HTTP 401;
 * - `unreachable`: a failure that trying again later may cure: no connection,
 *   a connection that closed in the middle of an exchange, HTTP 5xx, or HTTP
 *   429;
 * - `timeout`: the server did not answer in time;
 * - `unsupported-revision`: the server speaks none of the MCP revisions we do;
 * - `too-large`: a message was over `MAX_UPSTREAM_MESSAGE_BYTES`, or a tool
 *   list was over its limits (`limitToolListing`);
 * - `not-on-origin`: the plugin built a URL outside its server's origin, so
 *   nothing was sent;
 * - `not-serving`: the controller is frozen or sealed, so nothing was sent;
 *   `message` is then the promotion gate's own text;
 * - `refused`: the caller's `PrepareSend` refused the request, so nothing was
 *   sent. The caller knows why;
 * - `protocol`: the server answered, but not with something we can use (a
 *   redirect, an HTTP 4xx other than 401 and 429, a message that is not MCP).
 */
const UPSTREAM_FAILURE_REASONS = [
  "unauthorized",
  "unreachable",
  "timeout",
  "unsupported-revision",
  "too-large",
  "not-on-origin",
  "not-serving",
  "refused",
  "protocol",
] as const;

type UpstreamFailureReason = (typeof UPSTREAM_FAILURE_REASONS)[number];

/**
 * An upstream call failed. `message` is one fixed line a person can read; it
 * never holds the server's answer, headers or the credentials. For
 * `unauthorized`:
 *
 * - `sentIdentity` is the identity of the credentials the rejected request
 *   carried, which `refreshAfterRejection` needs;
 * - `offersOAuth` is whether the server's challenge points at OAuth metadata
 *   (a `resource_metadata` parameter in `WWW-Authenticate`), which tells the
 *   user whether signing in with OAuth is possible. The header's text itself
 *   is outside input and is never kept.
 */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  reason: Schema.Literals(UPSTREAM_FAILURE_REASONS),
  message: Schema.String,
  sentIdentity: Schema.optionalKey(Schema.String),
  offersOAuth: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * Runs right before a request that starts an exchange goes out, and returns
 * the credentials the request carries. It reads the credentials as they are
 * then, runs the caller's checks after that read, and fails when a check
 * refuses. A failure sends nothing. It fails with an `UpstreamError`, which
 * should have reason `refused` or `not-serving`, or with the caller's own
 * `Refusal`, which the call that sent the request then fails with.
 *
 * Only the requests of a call can fail with a `Refusal`, because a call is
 * the one thing that has a caller to tell. The requests that open a session
 * fail with an `UpstreamError`, which an opening shared by several calls can
 * give to all of them.
 */
export type PrepareSend<Refusal = never> = Effect.Effect<
  UpstreamCredentials,
  UpstreamError | Refusal
>;

/**
 * What the caller of a call can read while the call runs. The upstream client
 * writes it.
 */
export interface ToolCallProgress {
  /**
   * The call's own `tools/call` request went out in the attempt that runs now.
   * From then on the call may have run, so a failure no longer says that the
   * call can be sent again. An attempt starts with it `false`.
   */
  toolPostSent: boolean;
}

/**
 * What the requests of one call keep for themselves while they go through the
 * upstream client, which concurrent calls share. `callTool` of `OpenedUpstream`
 * makes one and provides it (see `CurrentUpstreamCall`), and the client reads
 * and writes it for each request the call causes, so one call never sees the
 * credentials, the status or the identity of another. The requests that
 * belong to no call, the opening and the closing of the session, share one
 * state of their own.
 */
interface UpstreamCallState<Refusal = never> {
  /**
   * Runs before a request of this state that starts an exchange, such as the
   * call's own `tools/call` request, and gives the credentials the request
   * carries. Without it, such a request waits for the thaw and carries the
   * credentials sent last.
   */
  readonly prepareSend: PrepareSend<Refusal> | undefined;
  /** The credentials the last request of this state carried. `undefined` until one was sent. */
  sentCredentials: UpstreamCredentials | undefined;
  /**
   * Why the client refused to send a request of this state, when it did. The
   * client can only fail with its own error, so the reason is kept here for
   * the code that returns the failure of the call.
   */
  refusal: UpstreamError | Refusal | undefined;
  /** Whether the call's own `tools/call` request was sent. */
  readonly progress: ToolCallProgress;
  /**
   * The HTTP status the server answered the call's own `tools/call` request
   * with. `undefined` until it answered. A failure of any other request of the
   * call, such as the reply to a request of the server, says nothing about
   * whether the tool ran.
   */
  toolPostStatus: number | undefined;
  /** The call's `sentValues` (see `ToolCall`). */
  readonly sentValues: Set<string>;
}

const CurrentUpstreamCall = Context.Reference<UpstreamCallState<unknown> | undefined>(
  "hercule/controller/mcp-servers/CurrentUpstreamCall",
  { defaultValue: () => undefined },
);

/**
 * The HTTP statuses besides 403 with which a server answers the tool's own
 * request when it refuses that call: a request it cannot read (400), a request
 * that is too large (413) and arguments it rejects (422). They are about this
 * call, not about the server.
 */
const CALL_REFUSAL_STATUSES: ReadonlyArray<number> = [400, 413, 422];

/** The answer to the agent when the server answers the tool's own request with HTTP `status`. */
const describeRefusedCall = (status: number): string =>
  `the server refused this call (HTTP ${String(status)})`;

/** The answer to the agent when the server asks for something a call cannot give, such as more input. */
const UNSUPPORTED_ANSWER =
  "this call needs something Hercule does not support, such as a request for more input, so it was not completed";

/** The answer to the agent when the arguments or the server's answer do not fit the tool's description. */
const MALFORMED_CALL_ANSWER =
  "the call's arguments or the server's answer did not fit what the tool declares, so it was not completed. Check the arguments";

/** The answer to the agent when removing credential values broke the server's answer to a call. */
const UNCLEANABLE_ANSWER = "The server's answer held the credential and could not be cleaned.";

/** Builds the tool result of a call that failed: `text` tells the agent what happened. */
export const buildErrorResult = (text: string): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text }], isError: true });

/**
 * A call found its upstream MCP session expired, and the call did not run:
 * either the server answered 404 to the tool's own request, or the session was
 * already known to be gone and the request was never sent. The caller may send
 * the call again on a new session.
 */
export interface SessionExpired {
  readonly _tag: "SessionExpired";
}

/**
 * A call's tool request went out and may have run, and then the exchange
 * failed in a way that must not send the tool again: a 401 or an ended MCP
 * session on the reply to a request of the server, not on the tool's own
 * request. `sessionExpired` tells whether the upstream MCP session is gone, so
 * the caller stops using it although it does not send the tool again.
 */
export interface ExchangeBroken {
  readonly _tag: "ExchangeBroken";
  readonly sessionExpired: boolean;
}

/** Tells whether the request's body is a JSON-RPC request for `tools/call`. */
const isToolCallRequest = (request: HttpClientRequest.HttpClientRequest): boolean => {
  const { body } = request;
  if (body._tag !== "Uint8Array") return false;
  try {
    const message: unknown = JSON.parse(new TextDecoder().decode(body.body));
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { readonly method?: unknown }).method === "tools/call"
    );
  } catch {
    return false;
  }
};

type ClientProtocol = Parameters<typeof McpClient.http>[0]["protocol"];

/**
 * Passes the protocol module of an older revision to the client. Effect's
 * client types accept only `2025-11-25` and `2026-07-28`, but its protocol
 * modules for `2025-06-18` and `2025-03-26` work with the same client
 * (Sentry's server answers `2025-06-18`). This is the one place that cast is
 * made.
 */
const castToClientProtocol = (adapter: unknown): ClientProtocol => adapter as ClientProtocol;

/** The MCP revisions to try, newest first. */
const REVISIONS: ReadonlyArray<{ readonly revision: string; readonly protocol: ClientProtocol }> = [
  { revision: "2026-07-28", protocol: McpProtocol.v2026_07_28 },
  { revision: "2025-11-25", protocol: McpProtocol.v2025_11_25 },
  { revision: "2025-06-18", protocol: castToClientProtocol(McpProtocol.v2025_06_18) },
  { revision: "2025-03-26", protocol: castToClientProtocol(McpProtocol.v2025_03_26) },
];

/** What a person reads for each reason, unless a failure has a more precise line. */
const FIXED_MESSAGES: Record<UpstreamFailureReason, string> = {
  unauthorized: "The server refused the credentials (HTTP 401)",
  unreachable: "The server could not be reached",
  timeout: "The server did not answer in time",
  "unsupported-revision": "The server speaks no MCP revision that Hercule can use",
  "too-large": "The server sent a message larger than 4 MiB",
  "not-on-origin":
    "The plugin built a request to an address outside its server's origin, so nothing was sent",
  "not-serving": "The controller is not serving",
  refused: "The request was not sent, because a check before it refused it",
  protocol: "The server answered with something that is not valid MCP",
};

const buildFailure = (
  reason: UpstreamFailureReason,
  extra: {
    readonly message?: string;
    readonly sentIdentity?: string;
    readonly offersOAuth?: boolean;
  } = {},
): UpstreamError =>
  new UpstreamError({
    reason,
    message: extra.message ?? FIXED_MESSAGES[reason],
    ...(extra.sentIdentity === undefined ? {} : { sentIdentity: extra.sentIdentity }),
    ...(extra.offersOAuth === undefined ? {} : { offersOAuth: extra.offersOAuth }),
  });

/**
 * Tells whether a `WWW-Authenticate` header has a `Bearer` challenge with a
 * `resource_metadata` parameter, which is how a server points at the OAuth
 * metadata of its resource (RFC 9728). A header may hold several challenges
 * (`Basic realm="x", Bearer resource_metadata="..."`), and the parameter
 * counts only inside the `Bearer` one. Quoted values are blanked first, so a
 * comma or a parameter name inside another parameter's text changes nothing.
 */
const offersOAuthMetadata = (wwwAuthenticate: string | undefined): boolean => {
  if (wwwAuthenticate === undefined) return false;
  let inBearerChallenge = false;
  for (const part of wwwAuthenticate.replace(/"(?:[^"\\]|\\.)*"/g, '""').split(",")) {
    const text = part.trim();
    // A part that starts a challenge is a scheme, then a space, then the
    // challenge's first parameter. A parameter of the current challenge is
    // `name=value`, with the name directly followed by `=`.
    const isParameter = /^[^\s=]+\s*=/.test(text);
    const challenge = isParameter ? null : /^(\S+)(?:\s+(.*))?$/.exec(text);
    if (challenge !== null) inBearerChallenge = challenge[1]?.toLowerCase() === "bearer";
    const parameter = challenge === null ? text : (challenge[2] ?? "");
    if (inBearerChallenge && /^resource_metadata\s*=/i.test(parameter)) return true;
  }
  return false;
};

/**
 * Counts one answer to `tools/list` into `listing`, and returns the client
 * failure that ends the listing when it passed a limit, and `undefined`
 * otherwise. A listing ends as soon as:
 *
 * - the tools read so far pass `MAX_TOOL_DEFINITIONS_BYTES`, so a server that
 *   never stops sending pages cannot make the controller hold them all. Each
 *   tool is measured whole, as the client keeps it in memory, `icons` and
 *   `_meta` included, and not only by the fields that are stored;
 * - the page just read is the last page allowed and the server points at one
 *   more.
 *
 * The client pages a listing by itself, up to 100 pages, and only hands the
 * whole list back at the end. This runs on every answer instead, so the limit
 * applies while the list is read. `listing.exceeded` holds the failure with
 * its fixed message for the caller, because the client fails with its own
 * error type.
 */
const limitToolListing = (
  listing: ToolListing,
  result: unknown,
): McpClientError.McpClientError | undefined => {
  const page =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const tools: ReadonlyArray<unknown> = Array.isArray(page["tools"]) ? page["tools"] : [];
  listing.pages += 1;
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    // One byte more for the comma between two tools.
    listing.bytes += new TextEncoder().encode(JSON.stringify(tool)).length + 1;
  }
  const message =
    listing.bytes > MAX_TOOL_DEFINITIONS_BYTES
      ? TOOL_LIST_TOO_LARGE
      : listing.pages >= MAX_TOOL_LIST_PAGES && typeof page["nextCursor"] === "string"
        ? `The server's tool list has more than ${String(MAX_TOOL_LIST_PAGES)} pages`
        : undefined;
  if (message === undefined) return undefined;
  listing.exceeded = buildFailure("too-large", { message });
  return new McpClientError.McpClientError({
    reason: new McpClientError.LimitError({ description: message }),
  });
};

/**
 * Checks that a URL an endpoint built may carry credentials: `http` or `https`,
 * exactly the endpoint's origin, and no user name or password. Returns the
 * `not-on-origin` failure when it may not, and `undefined` when it may.
 */
export const checkUrlOnOrigin = (origin: string, url: string): UpstreamError | undefined => {
  if (!URL.canParse(url)) return buildFailure("not-on-origin");
  const parsed = new URL(url);
  const allowed =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin === origin &&
    parsed.username === "" &&
    parsed.password === "";
  return allowed ? undefined : buildFailure("not-on-origin");
};

/** The newest MCP revision. Its handshake is `server/discover`; every older one starts with `initialize`. */
const MODERN_REVISION = "2026-07-28";

/**
 * The JSON-RPC error codes with which a server that does not know
 * `server/discover` can answer it: method not found, invalid request, the
 * official TypeScript SDK's "Bad Request" (-32000, "Server not initialized"
 * or "Unsupported protocol version"), and MCP's unsupported-version error.
 */
const DISCOVER_REFUSAL_CODES: ReadonlyArray<number> = [
  McpSchema.METHOD_NOT_FOUND_ERROR_CODE,
  McpSchema.INVALID_REQUEST_ERROR_CODE,
  -32000,
  McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
];

/** The HTTP statuses with which a server that does not know `server/discover` can answer it. */
const DISCOVER_REFUSAL_STATUSES: ReadonlyArray<number> = [400, 404, 405];

/**
 * Tells whether the failure of a handshake shows that the server does not
 * speak the revision that was tried, so the next older revision should be
 * tried (MCP's versioning rules):
 *
 * - The modern handshake, `server/discover`, is unknown to every older
 *   server, and they answer it in different ways. It counts as refused on
 *   HTTP 400, 404 or 405, on a JSON-RPC error with one of the codes in
 *   `DISCOVER_REFUSAL_CODES`, and when the server's answer lists no support
 *   for the revision.
 * - An older handshake, `initialize`, is refused when the server answers
 *   another revision, or HTTP 400 with MCP's unsupported-version code.
 *
 * Every other failure says nothing about revisions and ends the attempt: a
 * 401, 403, 429, a 5xx, a transport failure and a timeout, because another
 * revision would not change them.
 */
const isVersionRefusal = (error: McpClientError.McpClientError, revision: string): boolean => {
  const reason = error.reason;
  if (reason._tag === "UnsupportedError") return true;
  if (revision === MODERN_REVISION) {
    if (reason._tag === "HttpError") return DISCOVER_REFUSAL_STATUSES.includes(reason.status);
    return (
      reason._tag === "ProtocolError" &&
      reason.code !== undefined &&
      DISCOVER_REFUSAL_CODES.includes(reason.code)
    );
  }
  return (
    reason._tag === "HttpError" &&
    reason.status === 400 &&
    reason.code === McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE
  );
};

/**
 * Converts a failure of the MCP client into an `UpstreamError` with a fixed
 * message. `rejectedIdentity` is the identity of the credentials the last
 * request that got a 401 carried.
 */
export const describeClientFailure = (
  error: McpClientError.McpClientError,
  rejectedIdentity: string | undefined,
): UpstreamError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "HttpError": {
      if (reason.status === 401) {
        return buildFailure("unauthorized", {
          ...(rejectedIdentity === undefined ? {} : { sentIdentity: rejectedIdentity }),
          offersOAuth: offersOAuthMetadata(reason.wwwAuthenticate),
        });
      }
      if (
        reason.status === 400 &&
        reason.code === McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE
      ) {
        return buildFailure("unsupported-revision");
      }
      if (reason.status === 429 || reason.status >= 500) {
        return buildFailure("unreachable", {
          message: `The server answered with HTTP status ${String(reason.status)}`,
        });
      }
      const message =
        reason.status >= 300 && reason.status < 400
          ? `The server answered with a redirect (HTTP ${String(reason.status)}), which is not followed`
          : `The server answered with HTTP status ${String(reason.status)}`;
      return buildFailure("protocol", { message });
    }
    case "TransportError":
      return buildFailure("unreachable");
    case "TimeoutError":
      return buildFailure("timeout");
    case "LimitError":
      return buildFailure("too-large");
    case "ClosedError":
      // An ended MCP session is the server's answer. A closed connection is
      // a broken exchange, which may work next time.
      return reason.sessionExpired === true
        ? buildFailure("protocol", { message: "The server ended the MCP session" })
        : buildFailure("unreachable", { message: "The connection to the server closed" });
    default:
      return buildFailure("protocol");
  }
};

/** One call of a tool on an open upstream session. */
export interface ToolCall<Refusal = never> {
  readonly tool: McpSchema.Tool;
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  /** Runs before the call's own `tools/call` request, and gives the credentials it carries. */
  readonly prepareSend: PrepareSend<Refusal>;
  /** Tells the caller whether the call's own request went out. See `ToolCallProgress`. */
  readonly progress: ToolCallProgress;
  /**
   * Collects every secret credential value (`secretNames`) that any attempt
   * of the logical call sent. The caller gives every attempt the
   * same set, also an attempt on another upstream session, so a value from a
   * rejected attempt is removed from the answer of a later one.
   */
  readonly sentValues: Set<string>;
}

/** An open upstream session, and what a caller does with it. */
export interface OpenedUpstream {
  /** The MCP revision that worked. Store it and pass it as `firstRevision` next time. */
  readonly revision: string;
  /**
   * Lists the server's tools. Removes from them every credential value the
   * session sent. A tool whose name holds one is left out and logged,
   * because the name is what a call sends back, so rewriting it would
   * dispatch to another tool or to none. A tool that no longer decodes as
   * `McpSchema.Tool` after the removal is left out and logged too. The log
   * line names the server and never the tool. Fails with an `UpstreamError`, with
   * reason `too-large` when the list passed 4 MiB of definitions or 100 pages
   * (`limitToolListing`).
   */
  readonly listTools: (
    timeout: Duration.Duration,
  ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, UpstreamError>;
  /**
   * Calls a tool and returns the server's answer with every credential value
   * the session and the call sent removed. A failure of this call alone is its answer, not
   * a failure of the server, and comes back as a result with `isError`: a
   * JSON-RPC error, HTTP 403, an answer that asks for input the client cannot
   * give, a request the client refused to send, a result that does not decode,
   * and HTTP 400, 413 or 422 to the tool's own request.
   *
   * Fails with:
   *
   * - `SessionExpired` when the call did not run because its MCP session is
   *   gone, so the caller may send it again on a new session;
   * - `ExchangeBroken` when the tool's request went out and a later request
   *   of its exchange failed, so the call may have run;
   * - the `Refusal` of the call's `prepareSend`, when a request that starts
   *   an exchange was refused;
   * - an `UpstreamError` otherwise. Only a 401 to the tool's own request has
   *   reason `unauthorized`, which lets the caller refresh the credentials
   *   and send the call again.
   */
  readonly callTool: <Refusal>(
    call: ToolCall<Refusal>,
  ) => Effect.Effect<
    McpSchema.CallToolResult,
    UpstreamError | Refusal | SessionExpired | ExchangeBroken
  >;
}

/** What `openUpstream` needs. */
export interface UpstreamTarget {
  readonly endpoint: UpstreamEndpoint;
  /**
   * The credentials the transport's address is built from, and that the
   * closing of the upstream session carries. Without `prepareSend`, every
   * request that belongs to no call carries them. A call sends its own (see
   * `UpstreamCallState`).
   */
  readonly credentials: UpstreamCredentials;
  /** The revision that worked last time, tried first, or `null`. */
  readonly firstRevision: string | null;
  /**
   * Runs before every request that belongs to no call and starts an
   * exchange, such as the handshake that opens the session, and gives the
   * credentials it carries (see `PrepareSend`). With it, such a request fails
   * at once while the controller is frozen or sealed, even for a caller that
   * the freeze is waiting for. Without it, such a request waits for the
   * thaw, as a check does.
   */
  readonly prepareSend?: PrepareSend;
  /**
   * Reads the credentials as they are stored now, for a request that only
   * continues an exchange that already went out (such as the reply to a
   * request of the server) and for the request that ends the upstream
   * session. It runs no check of a caller, and must never start a refresh.
   * Without it, those requests carry what the client sent last. When it
   * fails, the request is not sent.
   */
  readonly readCurrentCredentials?: PrepareSend;
  /**
   * Collects every secret credential value (`secretNames`) that a request of
   * this session sent. The caller keeps the set, so it still has
   * the values of a session that failed to open or expired and is replaced.
   * Without it, the session keeps a set of its own.
   */
  readonly sentValues?: Set<string>;
}

/**
 * Opens an MCP client to the endpoint's server and returns it with the
 * revision that worked. The client stays open until the scope closes, which
 * also ends the upstream session.
 *
 * Revisions are tried in the order `2026-07-28`, `2025-11-25`, `2025-06-18`,
 * `2025-03-26`, with `firstRevision` moved to the front. The next one is tried
 * only when the server refuses the revision, as `isVersionRefusal` decides.
 * Any other failure ends the attempt, because another revision would not
 * change it.
 *
 * Fails with an `UpstreamError`: `not-on-origin` before anything is sent,
 * `not-serving` when `prepareSend` is set and the controller is not serving,
 * the failure of `prepareSend` itself, and otherwise as
 * `describeClientFailure` converts the client's failure. Needs an
 * `HttpClient`, and sends only while the controller is serving.
 */
export const openUpstream = (
  target: UpstreamTarget,
): Effect.Effect<
  OpenedUpstream,
  UpstreamError,
  HttpClient.HttpClient | PromotionState | Scope.Scope
> =>
  Effect.gen(function* () {
    const { endpoint } = target;
    const promotion = yield* PromotionState;
    const baseClient = yield* HttpClient.HttpClient;
    const outer = yield* Scope.Scope;

    const sentValues = target.sentValues ?? new Set<string>();
    const listing: ToolListing = { pages: 0, bytes: 0, exceeded: undefined };
    // The state of the requests that belong to no call.
    const sessionState: UpstreamCallState = {
      prepareSend: target.prepareSend,
      sentCredentials: undefined,
      refusal: undefined,
      progress: { toolPostSent: false },
      toolPostStatus: undefined,
      sentValues,
    };

    const buildRequest = (credentials: UpstreamCredentials) =>
      Effect.try({
        try: () => endpoint.buildRequest(credentials),
        // The function is pure and should not throw. If it does, say nothing
        // of what it threw, because that may hold the credentials.
        catch: () => buildFailure("not-on-origin"),
      });

    const readCurrentCredentials: PrepareSend =
      target.readCurrentCredentials ??
      Effect.sync(() => sessionState.sentCredentials ?? target.credentials);

    const first = yield* buildRequest(target.credentials);
    const refusedFirst = checkUrlOnOrigin(endpoint.origin, first.url);
    if (refusedFirst !== undefined) return yield* Effect.fail(refusedFirst);

    const sendingClient = baseClient.pipe(
      HttpClient.transform((send) =>
        send.pipe(
          // A redirect would carry the credentials to another origin.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          // No span at all: a client span records the URL, and a failed one
          // records the error text, which may hold a credential. Without a
          // span there is also nothing to propagate to the outside server.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        ),
      ),
    );

    // The client does its work inside one `makeWith` step instead of
    // `mapRequestEffect`, because the HTTP client runs every request mapping
    // before it runs a `transform`, and the plugin must build the request,
    // with the credentials, only once the controller is known to be serving.
    const buildTransportFailure = (
      request: HttpClientRequest.HttpClientRequest,
      description: string,
    ) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description }),
      });

    /**
     * Builds the request with `used`, checks its URL, and sends it. `state`
     * records the credentials, the credential values and the answer to the
     * call's own `tools/call` request.
     */
    const sendWith = (
      request: HttpClientRequest.HttpClientRequest,
      used: UpstreamCredentials,
      state: UpstreamCallState<unknown>,
      startsExchange: boolean,
    ) =>
      Effect.gen(function* () {
        const built = yield* buildRequest(used);
        state.sentCredentials = used;
        for (const name of used.secretNames) {
          const value = used.credentials[name];
          if (value !== undefined && value !== "") {
            sentValues.add(value);
            state.sentValues.add(value);
          }
        }
        // The URL that is sent is the one just built and checked, so a
        // credential in the URL is the current one.
        const refused = checkUrlOnOrigin(endpoint.origin, built.url);
        if (refused !== undefined) return yield* Effect.fail(refused);
        // A request that goes out clears an older refusal of the requests that
        // belong to no call, so a later failure is not taken for it. The closing
        // of the session does not, because a failed opening closes its transport
        // before its failure is described.
        if (state === sessionState && startsExchange) state.refusal = undefined;
        // The call's own `tools/call` request is the first request of the call
        // that carries one.
        const isToolPost =
          startsExchange && !state.progress.toolPostSent && isToolCallRequest(request);
        if (isToolPost) state.progress.toolPostSent = true;
        const response = yield* sendingClient.execute(
          HttpClientRequest.setUrl(HttpClientRequest.setHeaders(request, built.headers), built.url),
        );
        if (isToolPost) state.toolPostStatus = response.status;
        return response;
      });

    /**
     * Sends a request that starts an exchange or continues one. See the rules
     * at the top of this file.
     */
    const sendExchange = (
      request: HttpClientRequest.HttpClientRequest,
      state: UpstreamCallState<unknown>,
    ) =>
      Effect.gen(function* () {
        // Once the tool request went out, the other requests of the call only
        // continue its exchange, such as the reply to a request of the server.
        // They carry the credentials stored now and are let through while not
        // serving, so the exchange settles. Reading the credentials starts no
        // refresh while the controller is not serving.
        if (state.progress.toolPostSent) {
          return yield* promotion.whenServing(
            Effect.flatMap(readCurrentCredentials, (used) => sendWith(request, used, state, false)),
          );
        }
        const { prepareSend } = state;
        if (prepareSend === undefined) {
          return yield* promotion.whenServing(
            sendWith(request, state.sentCredentials ?? target.credentials, state, true),
          );
        }
        // The request is counted from the moment `prepareSend` starts, so a
        // freeze that comes while it reads the credentials waits for this
        // request. `prepareSend` ends with the check that the controller is
        // serving, and nothing but building the request stands between that
        // check and the send.
        const prepared = Effect.catch(prepareSend, (refusal) =>
          Effect.andThen(
            Effect.sync(() => {
              state.refusal = refusal;
            }),
            Effect.fail(buildTransportFailure(request, "A check before the request refused it")),
          ),
        );
        return yield* promotion
          .admit(Effect.flatMap(prepared, (used) => sendWith(request, used, state, true)))
          .pipe(
            Effect.catch((failure) =>
              failure instanceof UpstreamError || failure instanceof HttpClientError.HttpClientError
                ? Effect.fail(failure)
                : Effect.fail(buildFailure("not-serving", { message: failure.error.message })),
            ),
          );
      }).pipe(
        // The client may fail only with its own error type, so the refusal is
        // kept aside and `describeFailure` returns it.
        Effect.catchTag("UpstreamError", (refused) =>
          Effect.andThen(
            Effect.sync(() => {
              state.refusal = refused;
            }),
            Effect.fail(buildTransportFailure(request, refused.message)),
          ),
        ),
      );

    /**
     * Sends the DELETE that ends the upstream MCP session. The server ends
     * the session by itself in time, so a DELETE is never worth waiting for a
     * thaw, or sending after one: it is not sent unless the controller is
     * serving, which is checked again after the credentials were read, right
     * before the request goes out. It carries the credentials stored now, or
     * the ones the client sent last when the target reads none, and runs no
     * check of a call, because it happens when a call's token has ended.
     */
    const sendSessionEnd = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.flatMap(promotion.phase, (phase) =>
        phase._tag === "Serving"
          ? promotion
              .whenServing(
                Effect.flatMap(readCurrentCredentials, (used) =>
                  Effect.andThen(
                    Effect.mapError(promotion.refuseUnlessServing, (error) =>
                      buildFailure("not-serving", { message: error.error.message }),
                    ),
                    sendWith(request, used, sessionState, false),
                  ),
                ),
              )
              .pipe(
                Effect.catchTag("UpstreamError", (refused) =>
                  Effect.fail(buildTransportFailure(request, refused.message)),
                ),
              )
          : Effect.fail(buildTransportFailure(request, "The controller is not serving")),
      );

    const client = HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
      (pending) =>
        Effect.flatMap(pending, (request) =>
          request.method === "DELETE"
            ? sendSessionEnd(request)
            : Effect.flatMap(CurrentUpstreamCall, (call) =>
                sendExchange(request, call ?? sessionState),
              ),
        ),
      Effect.succeed,
    );

    const describeFailure = <Refusal = never>(
      error: McpClientError.McpClientError,
      state: UpstreamCallState<Refusal> = sessionState,
    ): UpstreamError | Refusal =>
      state.refusal ??
      describeClientFailure(error, (state.sentCredentials ?? target.credentials).identity);

    /** Removes the credential values the session sent, and those of `state`, from `value`. */
    const removeSentValues = <A>(value: A, state: UpstreamCallState<unknown> = sessionState): A =>
      removeCredentialValues(value, new Set([...sentValues, ...state.sentValues]));

    /** Decides what a failure of a call's request means: see `callTool` of `OpenedUpstream`. */
    const decideCallFailure = <Refusal>(
      error: McpClientError.McpClientError,
      call: UpstreamCallState<Refusal>,
    ): Effect.Effect<
      McpSchema.CallToolResult,
      UpstreamError | Refusal | SessionExpired | ExchangeBroken
    > => {
      const reason = error.reason;
      if (reason._tag === "ClosedError" && reason.sessionExpired === true) {
        // The session is gone either because the server answered 404 to the
        // tool's own request, or because another request found it gone and
        // this one was never sent. Both leave the tool unrun. A 404 on any
        // other request of this call, sent after the tool, says nothing.
        return Effect.fail(
          call.progress.toolPostSent && call.toolPostStatus !== 404
            ? { _tag: "ExchangeBroken", sessionExpired: true }
            : { _tag: "SessionExpired" },
        );
      }
      // The server's own error for this call. A failure of the client itself
      // has no code.
      if (reason._tag === "ProtocolError" && reason.code !== undefined) {
        return Effect.succeed(
          buildErrorResult(
            removeSentValues(
              reason.description ?? "The server answered the call with an error.",
              call,
            ),
          ),
        );
      }
      if (reason._tag === "HttpError" && reason.status === 403) {
        return Effect.succeed(buildErrorResult(describeRefusedCall(403)));
      }
      // A failure of the call's own request, and a refusal by the client
      // before anything was sent, say nothing about the server as a whole, so
      // they are this call's answer and the server's status stays.
      if (reason._tag === "UnsupportedError") {
        return Effect.succeed(buildErrorResult(UNSUPPORTED_ANSWER));
      }
      if (reason._tag === "ValidationError") {
        return Effect.succeed(buildErrorResult(MALFORMED_CALL_ANSWER));
      }
      if (
        reason._tag === "HttpError" &&
        reason.status === call.toolPostStatus &&
        CALL_REFUSAL_STATUSES.includes(reason.status) &&
        reason.code !== McpSchema.UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE
      ) {
        return Effect.succeed(buildErrorResult(describeRefusedCall(reason.status)));
      }
      // The tool went out, and then a request that continues its exchange was
      // refused before it was sent, so the call may have run.
      if (call.progress.toolPostSent && call.refusal !== undefined) {
        return Effect.fail({ _tag: "ExchangeBroken", sessionExpired: false });
      }
      const failure = describeFailure(error, call);
      return failure instanceof UpstreamError &&
        failure.reason === "unauthorized" &&
        call.toolPostStatus !== 401
        ? Effect.fail({ _tag: "ExchangeBroken", sessionExpired: false })
        : Effect.fail(failure);
    };

    const buildOpened = (mcpClient: McpClient.McpClient, revision: string): OpenedUpstream => ({
      revision,
      listTools: (timeout) =>
        Effect.gen(function* () {
          listing.pages = 0;
          listing.bytes = 0;
          listing.exceeded = undefined;
          const tools = yield* mcpClient
            .listTools({ timeout })
            .pipe(Effect.mapError((error) => listing.exceeded ?? describeFailure(error)));
          const kept = tools.filter(
            (tool) => removeCredentialValues(tool.name, sentValues) === tool.name,
          );
          if (kept.length < tools.length) {
            yield* Effect.logWarning(
              `${endpoint.displayName}'s MCP server listed ${String(tools.length - kept.length)} tool(s) whose name holds a credential value. They were left out of the stored list.`,
            );
          }
          // Removing a value from a key can break the tool: a key the schema
          // requires, such as `inputSchema`, may hold a short token. What no
          // longer decodes is left out, like a tool whose name holds one.
          const scrubbed = removeSentValues(kept);
          const decodable = scrubbed.filter((tool) => Option.isSome(decodeTool(tool)));
          if (decodable.length < scrubbed.length) {
            yield* Effect.logWarning(
              `${endpoint.displayName}'s MCP server listed ${String(scrubbed.length - decodable.length)} tool(s) that were no longer a valid tool definition once credential values were removed from them. They were left out of the stored list.`,
            );
          }
          return decodable;
        }),
      callTool: <Refusal>(call: ToolCall<Refusal>) => {
        const state: UpstreamCallState<Refusal> = {
          prepareSend: call.prepareSend,
          sentCredentials: undefined,
          refusal: undefined,
          progress: call.progress,
          toolPostStatus: undefined,
          sentValues: call.sentValues,
        };
        call.progress.toolPostSent = false;
        return mcpClient
          .callTool({
            tool: call.tool,
            ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
          })
          .pipe(
            Effect.provideService(CurrentUpstreamCall, state),
            Effect.map((result) => {
              const scrubbed = removeSentValues(result, state);
              // Removing a value from a key can break the result: a key the
              // schema requires, such as `mimeType`, may be a short token. A
              // result that no longer decodes is replaced, like a stored tool
              // that no longer decodes is left out.
              return scrubbed === result || Option.isSome(decodeCallResult(scrubbed))
                ? scrubbed
                : buildErrorResult(UNCLEANABLE_ANSWER);
            }),
            Effect.catch((error) => decideCallFailure(error, state)),
          );
      },
    });

    const order = [
      ...REVISIONS.filter((entry) => entry.revision === target.firstRevision),
      ...REVISIONS.filter((entry) => entry.revision !== target.firstRevision),
    ];
    for (const { revision, protocol } of order) {
      // Each try has its own scope, so a refused try closes its transport (and
      // an upstream session it may have opened) before the next one starts.
      const attemptScope = yield* Scope.fork(outer, "sequential");
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          const transport = yield* McpClient.http({
            url: first.url,
            protocol,
            maxMessageBytes: MAX_UPSTREAM_MESSAGE_BYTES,
          });
          const limitedTransport = {
            ...transport,
            request: (message: McpSchema.JsonRpcRequest, tool?: McpSchema.Tool) =>
              Effect.flatMap(transport.request(message, tool), (response) => {
                const exceeded =
                  message.method === "tools/list" && "result" in response
                    ? limitToolListing(listing, response.result)
                    : undefined;
                return exceeded === undefined ? Effect.succeed(response) : Effect.fail(exceeded);
              }),
          };
          return yield* McpClient.make({ name: "hercule", version: VERSION }).pipe(
            Effect.provideService(McpClient.Transport, limitedTransport),
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Scope.Scope, attemptScope),
        ),
      );
      if (outcome._tag === "Success") {
        return buildOpened(outcome.success, revision);
      }
      yield* Scope.close(attemptScope, Exit.fail(outcome.failure));
      if (!isVersionRefusal(outcome.failure, revision)) {
        return yield* Effect.fail(describeFailure(outcome.failure));
      }
    }
    // Every revision was refused.
    return yield* Effect.fail(buildFailure("unsupported-revision"));
  });

/**
 * Converts a failure of an upstream call into the status an MCP Server shows
 * for it, with a detail a person can read. A server that cannot be reached or
 * does not answer in time is `unreachable`, because trying again later may
 * work. A server that refused the credentials has the status, the words and
 * the sign-in offer that its credentials give
 * (`ServerCredentials.describeRejected`). Every other failure is `error`, with
 * no sign-in offer: the server answered with something Hercule cannot use.
 * A check and a failed call both use this, so the two cannot read one answer
 * differently.
 */
export const buildStatusFromFailure = (
  failure: UpstreamError,
  credentials: Pick<ServerCredentials, "describeRejected">,
): {
  readonly status: "unreachable" | "error" | "needs-sign-in";
  readonly detail: string;
  readonly signInOffered: "oauth" | "token" | null;
} => {
  switch (failure.reason) {
    case "unreachable":
    case "timeout":
      return { status: "unreachable", detail: failure.message, signInOffered: null };
    case "unauthorized":
      return credentials.describeRejected(failure.offersOAuth === true);
    default:
      return { status: "error", detail: failure.message, signInOffered: null };
  }
};

/**
 * Runs `action` with the credentials of a server, and when the server refuses
 * them, refreshes them once and runs it again. Returns what the action
 * returned.
 *
 * The retry is allowed only when the action fails with an `UpstreamError` of
 * reason `unauthorized`, so an action must fail that way only when the server
 * refused the request that starts its exchange, before the server did
 * anything. An action that sent a request the server may already have run,
 * such as a tool call whose later request got the 401, must fail another way:
 * running it again could do the work twice. Any other failure of the action
 * ends it.
 *
 * A refresh changes the credentials, so a caller can refuse it when what it
 * works for has changed, in one of two ways. `checkRefreshAllowed` runs
 * before a refresh after a rejection, and when it fails the refresh and the
 * retry do not happen. `guardRefresh` runs right before every request to the
 * provider this causes, also the refresh of a stale token that the first read
 * starts (`RefreshGuard`).
 *
 * Fails with:
 *
 * - `ServerCredentialsUnavailable` when the server cannot give credentials,
 *   or cannot give new ones after the rejection;
 * - the action's `UpstreamError`, also when there is nothing to refresh
 *   (pasted credentials), and when the retry fails too;
 * - what `checkRefreshAllowed` and `guardRefresh` fail with.
 */
export const runWithCredentials = <
  A,
  F extends { readonly _tag: string } = never,
  E = never,
  G = never,
  R = never,
>(input: {
  readonly credentials: ServerCredentials;
  readonly action: (credentials: UpstreamCredentials) => Effect.Effect<A, UpstreamError | F, R>;
  readonly checkRefreshAllowed?: Effect.Effect<void, E, R>;
  readonly guardRefresh?: RefreshGuard<G>;
}): Effect.Effect<A, UpstreamError | F | ServerCredentialsUnavailable | E | G, R> =>
  Effect.gen(function* () {
    const { credentials: server, action, guardRefresh } = input;
    const credentials = yield* server.readForUse(guardRefresh);
    const first = yield* Effect.result(action(credentials));
    if (first._tag === "Success") return first.success;
    const rejected = first.failure;
    if (!(rejected instanceof UpstreamError) || rejected.reason !== "unauthorized") {
      return yield* Effect.fail(rejected);
    }

    if (input.checkRefreshAllowed !== undefined) yield* input.checkRefreshAllowed;
    const refreshed = yield* Effect.result(
      server.refreshAfterRejection(rejected.sentIdentity ?? credentials.identity, guardRefresh),
    );
    if (refreshed._tag === "Failure") {
      return yield* Effect.fail(
        refreshed.failure instanceof ServerCredentialsCannotRefresh ? rejected : refreshed.failure,
      );
    }
    return yield* action(refreshed.success);
  });
