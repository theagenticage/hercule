/**
 * Opens an MCP client to a server outside the controller, for a check or, in a
 * later step, for the gateway's calls (spec 21 sections 3.10, 5.1 and 5.6).
 *
 * The rules this file enforces for every request that leaves the controller:
 *
 * - The URL and headers come only from the plugin's `buildUpstreamRequest`,
 *   called with the credentials current at the moment of the request. The URL
 *   must be `http` or `https`, on the contribution's origin, with no user name
 *   or password. Otherwise nothing is sent.
 * - A redirect is never followed, so a credential never reaches another
 *   origin. A 3xx answer is an error.
 * - Nothing is sent while the controller is frozen or sealed.
 * - No trace headers go to the outside server.
 * - No failure carries the server's answer, its headers, the request or a
 *   credential: each failure has a fixed message.
 */
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
 * - `unreachable`: no connection, or the exchange broke off;
 * - `timeout`: the server did not answer in time;
 * - `unsupported-revision`: the server speaks none of the MCP revisions we do;
 * - `too-large`: a message was over `MAX_UPSTREAM_MESSAGE_BYTES`;
 * - `not-on-origin`: the plugin built a URL outside its server's origin, so
 *   nothing was sent;
 * - `protocol`: the server answered, but not with something we can use (a
 *   redirect, another HTTP error, a message that is not MCP).
 */
export const UPSTREAM_FAILURE_REASONS = [
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

type ClientProtocol = Parameters<typeof McpClient.http>[0]["protocol"];

/**
 * Passes the protocol module of an older revision to the client. Effect's
 * client types accept only `2025-11-25` and `2026-07-28`, but its protocol
 * modules for `2025-06-18` and `2025-03-26` work with the same client
 * (Sentry's server answers `2025-06-18`). This is the one place that cast is
 * made.
 */
const asClientProtocol = (adapter: unknown): ClientProtocol => adapter as ClientProtocol;

/** The MCP revisions to try, newest first. */
const REVISIONS: ReadonlyArray<{ readonly revision: string; readonly protocol: ClientProtocol }> = [
  { revision: "2026-07-28", protocol: McpProtocol.v2026_07_28 },
  { revision: "2025-11-25", protocol: McpProtocol.v2025_11_25 },
  { revision: "2025-06-18", protocol: asClientProtocol(McpProtocol.v2025_06_18) },
  { revision: "2025-03-26", protocol: asClientProtocol(McpProtocol.v2025_03_26) },
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

/**
 * Tells whether a failure of the handshake means the server does not speak
 * the revision we asked for: HTTP 400 with MCP's unsupported-version error
 * code, or the client's own "server answered another revision" error. Every
 * other failure, a 401 included, says nothing about revisions.
 */
const isVersionRefusal = (error: McpClientError.McpClientError): boolean => {
  const reason = error.reason;
  if (reason._tag === "UnsupportedError") return true;
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
      return buildFailure("protocol", {
        message:
          reason.sessionExpired === true
            ? "The server ended the MCP session"
            : "The connection to the server closed",
      });
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
   * The credentials every further request carries. Replace the value to carry
   * new credentials on the same upstream session, such as after a refresh.
   */
  readonly credentials: Ref.Ref<ConnectionCredentialsForUse>;
  /** Converts a failure of `client` into an `UpstreamError`. */
  readonly describeFailure: (error: McpClientError.McpClientError) => UpstreamError;
}

/** What `openUpstream` needs. */
export interface UpstreamTarget {
  readonly contribution: RegisteredMcpServer;
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
 * only when the server refuses the revision. A 401, any other 400, a timeout
 * or a transport failure ends the attempt, because another revision would not
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

    const credentials = yield* Ref.make(target.credentials);
    // The identity of the credentials each request carried, kept by request so
    // a 401 names the credentials of its own exchange.
    const identityOfRequest = new WeakMap<HttpClientRequest.HttpClientRequest, string>();
    const rejectedIdentity = yield* Ref.make<string | undefined>(undefined);
    const outboundRefusal = yield* Ref.make<UpstreamError | undefined>(undefined);

    const buildRequest = (current: ConnectionCredentialsForUse) =>
      Effect.try({
        try: () =>
          contribution.buildUpstreamRequest({
            credentials: current.credentials,
            config: current.config,
          }),
        // The plugin's function is pure and should not throw. If it does, say
        // nothing of what it threw, because that may hold the credentials.
        catch: () => buildFailure("not-on-origin"),
      });

    const first = yield* buildRequest(target.credentials);
    const refusedFirst = checkUrlOnOrigin(contribution.origin, first.url);
    if (refusedFirst !== undefined) return yield* Effect.fail(refusedFirst);

    const client: HttpClient.HttpClient = baseClient.pipe(
      HttpClient.mapRequestEffect((request) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(credentials);
          const built = yield* buildRequest(current);
          const refused =
            checkUrlOnOrigin(contribution.origin, built.url) ??
            checkUrlOnOrigin(contribution.origin, request.url);
          if (refused !== undefined) return yield* Effect.fail(refused);
          const sent = HttpClientRequest.setHeaders(request, built.headers);
          identityOfRequest.set(sent, current.identity);
          yield* Ref.set(outboundRefusal, undefined);
          return sent;
        }).pipe(
          // A wrapped client may fail only with the client's own error type,
          // so the refusal is kept aside and `describeFailure` returns it.
          Effect.catchTag("UpstreamError", (refused) =>
            Ref.set(outboundRefusal, refused).pipe(
              Effect.andThen(
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: refused.message,
                    }),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      HttpClient.transform((send, request) =>
        promotion
          .whenServing(
            Effect.tap(send, (response) => {
              const identity = identityOfRequest.get(request);
              return response.status === 401 && identity !== undefined
                ? Ref.set(rejectedIdentity, identity)
                : Effect.void;
            }),
          )
          .pipe(
            // A redirect would carry the credentials to another origin.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          ),
      ),
    );

    const describeFailure = (error: McpClientError.McpClientError): UpstreamError =>
      Ref.getUnsafe(outboundRefusal) ??
      describeClientFailure(error, Ref.getUnsafe(rejectedIdentity));

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
        return { client: outcome.success, revision, credentials, describeFailure };
      }
      yield* Scope.close(attemptScope, Exit.fail(outcome.failure));
      if (!isVersionRefusal(outcome.failure)) {
        return yield* Effect.fail(describeFailure(outcome.failure));
      }
    }
    // Every revision was refused.
    return yield* Effect.fail(buildFailure("unsupported-revision"));
  });
