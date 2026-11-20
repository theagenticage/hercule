/**
 * Opens an MCP client to a server outside the controller, for a check or, in a
 * later step, for the gateway's calls (spec 21 sections 3.10, 5.1 and 5.6).
 *
 * The rules this file enforces for every request that leaves the controller:
 *
 * - The URL and headers come only from the plugin's `buildUpstreamRequest`,
 *   called with the credentials the request is about to carry, after the
 *   controller is known to be serving. The URL must be `http` or `https`, on
 *   the contribution's origin, with no user name or password. Otherwise
 *   nothing is sent.
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
 *   exchange settles. It reads the credentials stored now, and starts no
 *   refresh of them while the controller is not serving.
 * - The HTTP client creates no trace spans, so no URL or error text reaches a
 *   trace, and no trace headers go to the outside server.
 * - No failure carries the server's answer, its headers, the request or a
 *   credential: each failure has a fixed message.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { McpClient, type McpClientError, McpProtocol, McpSchema } from "effect/ai";
import { VERSION } from "@hercule/home/version";
import type { ConnectionCredentialsForUse } from "../connections";
import type { RegisteredMcpServer } from "../plugins";
import { PromotionState } from "../promotion";

/** The largest message a server may send, or the controller may send: one JSON answer or one SSE event. */
export const MAX_UPSTREAM_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * Why an upstream call failed:
 *
 * - `unauthorized`: the server answered HTTP 401;
 * - `unreachable`: a failure that trying again later may cure: no connection,
 *   a connection that closed in the middle of an exchange, HTTP 5xx, or HTTP
 *   429;
 * - `timeout`: the server did not answer in time;
 * - `unsupported-revision`: the server speaks none of the MCP revisions we do;
 * - `too-large`: a message was over `MAX_UPSTREAM_MESSAGE_BYTES`;
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
 * never holds the server's answer, headers or the credentials. `sentIdentity`
 * is set for `unauthorized`: the identity of the credentials the rejected
 * request carried, which `refreshAfterRejection` needs.
 */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  reason: Schema.Literals(UPSTREAM_FAILURE_REASONS),
  message: Schema.String,
  sentIdentity: Schema.optionalKey(Schema.String),
}) {}

/**
 * Runs right before a request that starts an exchange goes out, and returns
 * the credentials the request carries. It reads the credentials as they are
 * then, runs the caller's checks after that read, and fails when a check
 * refuses. A failure sends nothing: the request fails with the
 * `UpstreamError` it fails with, which should have reason `refused` or
 * `not-serving`.
 */
export type PrepareSend = Effect.Effect<ConnectionCredentialsForUse, UpstreamError>;

/**
 * What one call keeps for itself while its requests go through the upstream
 * client, which concurrent calls share. A call provides one (see
 * `CurrentUpstreamCall`), and the client reads and writes it for each request
 * the call causes, so one call never sees the credentials, the status or the
 * identity of another.
 */
export interface UpstreamCallState {
  /**
   * Runs before the call's own `tools/call` request, which starts the call's
   * exchange. The request carries the credentials it returns.
   */
  readonly prepareSend: PrepareSend;
  /**
   * Reads the credentials as they are stored now, for a request that only
   * continues the call's exchange, such as the reply to a request of the
   * server. It runs no check of the caller, and starts no refresh while the
   * controller is not serving.
   */
  readonly readCurrentCredentials: PrepareSend;
  /**
   * The credentials the call's last request carried. `undefined` until a
   * request was sent.
   */
  sentCredentials: ConnectionCredentialsForUse | undefined;
  /** Why the client refused to send a request of this call, when it did. */
  refusal: UpstreamError | undefined;
  /** The call's own `tools/call` request was sent. */
  toolPostSent: boolean;
  /**
   * The HTTP status the server answered the call's own `tools/call` request
   * with. `undefined` until it answered. A failure of any other request of the
   * call, such as the reply to a request of the server, says nothing about
   * whether the tool ran.
   */
  toolPostStatus: number | undefined;
  /**
   * Every credential value any attempt of this call sent, longer than
   * `MIN_SECRET_LENGTH`: the values of the headers the plugin built and of the
   * credentials record. The caller of one logical call gives every attempt the
   * same set, also an attempt on another upstream session, and removes the
   * values from the text it returns.
   */
  readonly sentValues: Set<string>;
}

/**
 * Credential values of this many characters or fewer are too short to remove
 * from text without damaging it. A Connection a user pastes holds short fields
 * that are no secret, such as Sentry's organization slug, and removing them
 * would mangle ordinary answers. Every token and key a supported Connection
 * type holds is far longer.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Creates the state of one attempt of a call. `prepareSend` prepares its
 * `tools/call` request and `readCurrentCredentials` the requests that continue
 * its exchange. `sentValues` collects the credential values it sends.
 */
export const createUpstreamCallState = (
  prepareSend: PrepareSend,
  readCurrentCredentials: PrepareSend,
  sentValues: Set<string>,
): UpstreamCallState => ({
  prepareSend,
  readCurrentCredentials,
  sentCredentials: undefined,
  refusal: undefined,
  toolPostSent: false,
  toolPostStatus: undefined,
  sentValues,
});

export const CurrentUpstreamCall = Context.Reference<UpstreamCallState | undefined>(
  "hercule/controller/mcp-servers/CurrentUpstreamCall",
  { defaultValue: () => undefined },
);

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
  extra: { readonly message?: string; readonly sentIdentity?: string } = {},
): UpstreamError =>
  new UpstreamError({
    reason,
    message: extra.message ?? FIXED_MESSAGES[reason],
    ...(extra.sentIdentity === undefined ? {} : { sentIdentity: extra.sentIdentity }),
  });

/**
 * Checks that a URL a plugin built may carry credentials: `http` or `https`,
 * exactly the contribution's origin, and no user name or password. Returns the
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

/** An open upstream client, and what a caller needs to use and judge it. */
export interface OpenedUpstream {
  readonly client: McpClient.McpClient;
  /** The MCP revision that worked. Store it and pass it as `firstRevision` next time. */
  readonly revision: string;
  /**
   * Every credential value, longer than `MIN_SECRET_LENGTH`, that any request
   * on this session sent, the handshake and the calls' requests included: the
   * values of the headers the plugin built and of the credentials record. It
   * lives as long as the session. A caller removes them from what the server
   * answered, which it stores or hands on.
   */
  readonly sentValues: ReadonlySet<string>;
  /**
   * Converts a failure of `client` into an `UpstreamError`. `call` is the
   * call whose request failed, when there is one (see `UpstreamCallState`):
   * the failure then carries that call's refusal and the identity of the
   * credentials it sent. Without it, the failure carries what the client sent
   * last.
   */
  readonly describeFailure: (
    error: McpClientError.McpClientError,
    call?: UpstreamCallState,
  ) => UpstreamError;
}

/** What `openUpstream` needs. */
export interface UpstreamTarget {
  readonly contribution: RegisteredMcpServer;
  /**
   * The credentials the transport's address is built from, and that the
   * closing of the upstream session carries. Without `prepareSend`, every
   * request that belongs to no call carries them. A call sends its own (see
   * `UpstreamCallState`).
   */
  readonly credentials: ConnectionCredentialsForUse;
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
   * Reads the credentials as they are stored now, for the request that ends
   * the upstream session. Without it, that request carries what the client
   * sent last. When it fails, the request is not sent.
   */
  readonly readCurrentCredentials?: PrepareSend;
}

/**
 * Opens an MCP client to the contribution's server and returns it with the
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
    const { contribution } = target;
    const promotion = yield* PromotionState;
    const baseClient = yield* HttpClient.HttpClient;
    const outer = yield* Scope.Scope;

    const outboundRefusal = yield* Ref.make<UpstreamError | undefined>(undefined);

    // What a request carries when nothing prepares it, and the closing of the
    // session when nothing reads current credentials for it: what the client
    // sent last.
    let lastSent = target.credentials;
    const sentValues = new Set<string>();

    const buildRequest = (credentials: ConnectionCredentialsForUse) =>
      Effect.try({
        try: () =>
          contribution.buildUpstreamRequest({
            credentials: credentials.credentials,
            config: credentials.config,
          }),
        // The plugin's function is pure and should not throw. If it does, say
        // nothing of what it threw, because that may hold the credentials.
        catch: () => buildFailure("not-on-origin"),
      });

    const first = yield* buildRequest(lastSent);
    const refusedFirst = checkUrlOnOrigin(contribution.origin, first.url);
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
     * Builds the request with `used`, checks its URL, and sends it. A request
     * of a call records its credentials as the call's last. `toolPost` is the
     * call when this is the call's own `tools/call` request.
     */
    const sendWith = (
      request: HttpClientRequest.HttpClientRequest,
      used: ConnectionCredentialsForUse,
      call: UpstreamCallState | undefined,
      startsExchange: boolean,
      toolPost: UpstreamCallState | undefined,
    ) =>
      Effect.gen(function* () {
        const built = yield* buildRequest(used);
        lastSent = used;
        if (call !== undefined) call.sentCredentials = used;
        for (const value of [...Object.values(built.headers), ...Object.values(used.credentials)]) {
          if (value.length > MIN_SECRET_LENGTH) {
            sentValues.add(value);
            call?.sentValues.add(value);
          }
        }
        // The URL that is sent is the one just built and checked, so a
        // credential in the URL is the current one.
        const refused = checkUrlOnOrigin(contribution.origin, built.url);
        if (refused !== undefined) return yield* Effect.fail(refused);
        // A request that goes out clears an older refusal of the requests that
        // belong to no call, so a later failure is not taken for it. The closing
        // of the session does not, because a failed opening closes its transport
        // before its failure is described.
        if (call === undefined && startsExchange) yield* Ref.set(outboundRefusal, undefined);
        if (toolPost !== undefined) toolPost.toolPostSent = true;
        const response = yield* sendingClient.execute(
          HttpClientRequest.setUrl(HttpClientRequest.setHeaders(request, built.headers), built.url),
        );
        if (toolPost !== undefined) toolPost.toolPostStatus = response.status;
        return response;
      });

    /**
     * Sends a request that belongs to a call or to no call and starts an
     * exchange, or continues one. See the rules at the top of this file.
     */
    const sendExchange = (
      request: HttpClientRequest.HttpClientRequest,
      call: UpstreamCallState | undefined,
    ) =>
      Effect.gen(function* () {
        // The call's own `tools/call` request, which is the first request of
        // the call that carries one.
        const toolPost =
          call !== undefined && !call.toolPostSent && isToolCallRequest(request) ? call : undefined;
        // Once the tool request went out, the other requests of the call only
        // continue its exchange, such as the reply to a request of the server.
        // They carry the credentials stored now and are let through while not
        // serving, so the exchange settles. Reading the credentials starts no
        // refresh while the controller is not serving.
        if (call?.toolPostSent === true) {
          return yield* promotion.whenServing(
            Effect.flatMap(call.readCurrentCredentials, (used) =>
              sendWith(request, used, call, false, undefined),
            ),
          );
        }
        const prepareSend = call?.prepareSend ?? target.prepareSend;
        if (prepareSend === undefined) {
          return yield* promotion.whenServing(sendWith(request, lastSent, call, true, toolPost));
        }
        // The request is counted from the moment `prepareSend` starts, so a
        // freeze that comes while it reads the credentials waits for this
        // request. `prepareSend` ends with the check that the controller is
        // serving, and nothing but building the request stands between that
        // check and the send.
        return yield* promotion
          .admit(
            Effect.flatMap(prepareSend, (used) => sendWith(request, used, call, true, toolPost)),
          )
          .pipe(
            Effect.catch((failure) =>
              failure instanceof UpstreamError || failure instanceof HttpClientError.HttpClientError
                ? Effect.fail(failure)
                : Effect.fail(buildFailure("not-serving", { message: failure.error.message })),
            ),
          );
      }).pipe(
        // The client may fail only with its own error type, so the refusal is
        // kept aside and `describeFailure` returns it. A call keeps its own,
        // because calls share this client.
        Effect.catchTag("UpstreamError", (refused) =>
          Effect.andThen(
            call === undefined
              ? Ref.set(outboundRefusal, refused)
              : Effect.sync(() => {
                  call.refusal = refused;
                }),
            Effect.fail(buildTransportFailure(request, refused.message)),
          ),
        ),
      );

    /**
     * Sends the DELETE that ends the upstream MCP session. The server ends
     * the session by itself in time, so a DELETE is never worth waiting for a
     * thaw, or sending after one: it is not sent unless the controller is
     * serving. It carries the credentials stored now, or the ones the client
     * sent last when the target reads none, and runs no check of a call,
     * because it happens when a call's token has ended.
     */
    const sendSessionEnd = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.flatMap(promotion.phase, (phase) =>
        phase._tag === "Serving"
          ? promotion
              .whenServing(
                Effect.flatMap(
                  target.readCurrentCredentials ?? Effect.sync(() => lastSent),
                  (used) => sendWith(request, used, undefined, false, undefined),
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
            : Effect.flatMap(CurrentUpstreamCall, (call) => sendExchange(request, call)),
        ),
      Effect.succeed,
    );

    const describeFailure = (
      error: McpClientError.McpClientError,
      call?: UpstreamCallState,
    ): UpstreamError =>
      (call === undefined ? Ref.getUnsafe(outboundRefusal) : call.refusal) ??
      describeClientFailure(error, (call?.sentCredentials ?? lastSent).identity);

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
          return yield* McpClient.make({ name: "hercule", version: VERSION }).pipe(
            Effect.provideService(McpClient.Transport, transport),
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Scope.Scope, attemptScope),
        ),
      );
      if (outcome._tag === "Success") {
        return {
          client: outcome.success,
          revision,
          sentValues,
          describeFailure,
        };
      }
      yield* Scope.close(attemptScope, Exit.fail(outcome.failure));
      if (!isVersionRefusal(outcome.failure, revision)) {
        return yield* Effect.fail(describeFailure(outcome.failure));
      }
    }
    // Every revision was refused.
    return yield* Effect.fail(buildFailure("unsupported-revision"));
  });
