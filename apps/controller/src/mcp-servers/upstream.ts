/**
 * Opens an MCP client to a server outside the controller, for a check or, in a
 * later step, for the gateway's calls (spec 21 sections 3.10, 5.1 and 5.6).
 *
 * The rules this file enforces for every request that leaves the controller:
 *
 * - The URL and headers come only from the plugin's `buildUpstreamRequest`,
 *   called with the credentials the upstream was opened with, after the
 *   controller is known to be serving. The URL must be `http` or `https`, on
 *   the contribution's origin, with no user name or password. Otherwise
 *   nothing is sent.
 * - A redirect is never followed, so a credential never reaches another
 *   origin. A 3xx answer is an error.
 * - Nothing is sent while the controller is frozen or sealed.
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
 * Where one call keeps the identity of the credentials that its own request
 * carried. A call provides one, and the client writes into it when it sends the
 * call's request. Calls that run at once on one upstream session each have
 * their own, so a 401 is always matched with the credentials of the request
 * that got it. Without one, only the client's last-sent identity is kept.
 */
export interface UpstreamCallTrace {
  sentIdentity: string | undefined;
}

export const CurrentUpstreamCallTrace = Context.Reference<UpstreamCallTrace | undefined>(
  "hercule/controller/mcp-servers/CurrentUpstreamCallTrace",
  { defaultValue: () => undefined },
);

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
   * Converts a failure of `client` into an `UpstreamError`. `sentIdentity` is
   * the identity of the credentials of the request that failed, when the
   * caller knows it (see `CurrentUpstreamCallTrace`). Without it, the failure
   * carries the identity of the credentials the client sent last.
   */
  readonly describeFailure: (
    error: McpClientError.McpClientError,
    sentIdentity?: string,
  ) => UpstreamError;
  /**
   * Makes every request from now on carry these credentials. The upstream
   * MCP session stays open: the credentials go with each request.
   */
  readonly setCredentials: (credentials: ConnectionCredentialsForUse) => void;
}

/** What `openUpstream` needs. */
export interface UpstreamTarget {
  readonly contribution: RegisteredMcpServer;
  /** The credentials the first requests carry. `OpenedUpstream.setCredentials` replaces them. */
  readonly credentials: ConnectionCredentialsForUse;
  /** The revision that worked last time, tried first, or `null`. */
  readonly firstRevision: string | null;
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
 * Fails with an `UpstreamError`: `not-on-origin` before anything is sent, and
 * otherwise as `describeClientFailure` converts the client's failure. Needs an
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

    let current = target.credentials;
    let lastSentIdentity = target.credentials.identity;

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

    const first = yield* buildRequest(current);
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

    const client = HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
      (pending) =>
        Effect.flatMap(pending, (request) => {
          const send = promotion.whenServing(
            Effect.gen(function* () {
              const used = current;
              const trace = yield* CurrentUpstreamCallTrace;
              const built = yield* buildRequest(used);
              if (trace !== undefined) trace.sentIdentity = used.identity;
              lastSentIdentity = used.identity;
              const refused =
                checkUrlOnOrigin(contribution.origin, built.url) ??
                checkUrlOnOrigin(contribution.origin, request.url);
              if (refused !== undefined) return yield* Effect.fail(refused);
              yield* Ref.set(outboundRefusal, undefined);
              return yield* sendingClient.execute(
                HttpClientRequest.setHeaders(request, built.headers),
              );
            }).pipe(
              // The client may fail only with its own error type, so the
              // refusal is kept aside and `describeFailure` returns it.
              Effect.catchTag("UpstreamError", (refused) =>
                Ref.set(outboundRefusal, refused).pipe(
                  Effect.andThen(Effect.fail(buildTransportFailure(request, refused.message))),
                ),
              ),
            ),
          );
          if (request.method !== "DELETE") return send;
          // A DELETE only ends the upstream MCP session, which the server
          // ends by itself in time. It is never worth waiting for a thaw, or
          // sending after one, so it is not sent unless the controller serves.
          return Effect.flatMap(promotion.phase, (phase) =>
            phase._tag === "Serving"
              ? send
              : Effect.fail(buildTransportFailure(request, "The controller is not serving")),
          );
        }),
      Effect.succeed,
    );

    const describeFailure = (
      error: McpClientError.McpClientError,
      sentIdentity?: string,
    ): UpstreamError =>
      Ref.getUnsafe(outboundRefusal) ??
      describeClientFailure(error, sentIdentity ?? lastSentIdentity);

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
          describeFailure,
          setCredentials: (credentials) => {
            current = credentials;
          },
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
