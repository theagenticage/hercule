/**
 * The parts of an OAuth2 client that do not depend on what the tokens are
 * for: the token set and how it is stored, and the requests to a token
 * endpoint (authorization code exchange and refresh, RFC 6749 and RFC 7636).
 *
 * A Connection and an MCP Server added by URL both sign in through this code.
 * Neither domain's own rules are here: how a flow starts, what a refusal means
 * for the Connection or the server, and where the tokens are stored.
 */
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * A token is refreshed this long before it expires, or earlier by half its
 * lifetime when that is shorter (see `isStale`). A caller hands out a token
 * that must last through the poll or action that asked for it, and a poll can
 * take a minute or more. A token that expired halfway would get a 401, which
 * marks the sign-in as lost for nothing.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * The most bytes read from one answer of a token endpoint. A token answer is
 * a few hundred bytes, so a longer one is a mistake or an attack, and is
 * refused instead of being held in memory.
 */
export const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * The tokens the provider issued, as stored by `serializeTokens`.
 *
 * `obtainedAt` is the ISO time the provider's answer arrived. It is set
 * together with `expiresAt`, and `isStale` needs it to know the token's
 * lifetime. A set stored before the field existed has none.
 */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly obtainedAt?: string;
}

/**
 * How a client proves who it is to the token endpoint (RFC 6749 section 2.3).
 *
 * - `none`: a public client. Only its `client_id` is sent.
 * - `client_secret_post`: the client id and secret are fields of the form.
 * - `client_secret_basic`: the client id and secret are an `Authorization:
 *   Basic` header, each form-encoded first (RFC 6749 section 2.3.1).
 */
export type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/**
 * The client a token request identifies itself as.
 *
 * `authMethod` only matters for a client with a secret: a client without one
 * is public and sends its id alone, whatever `authMethod` says. A client with
 * a secret and no `authMethod` uses `client_secret_post`.
 */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authMethod?: ClientAuthMethod;
}

/**
 * The provider refused the request: the code, refresh token or device code
 * that was sent is treated as the problem. `code` is the OAuth error code the
 * provider answered with, such as `invalid_grant` or `authorization_pending`.
 * It is absent when the provider sent a client error with no code, and when
 * its code is not one that `STANDARD_ERROR_CODES` lists. `interval` is the new
 * polling interval in seconds, which a provider may send with `slow_down`.
 *
 * A provider may send an error with status 200 rather than 400, as GitHub
 * does. The body decides, not the status.
 *
 * The message never holds text the provider sent, only the vetted `code`: the
 * message ends up in status details and in answers to people and agents.
 */
export class ProviderRefused extends Schema.TaggedError<ProviderRefused>()("ProviderRefused", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Number),
}) {}

/**
 * The provider could not be reached, failed with a server error, rate limited
 * the request, or answered with a body that is neither tokens nor an OAuth
 * error. This error says nothing about the credential: a DNS failure or a
 * dropped network is not something the user can fix by signing in again.
 */
export class ProviderUnreachable extends Schema.TaggedError<ProviderUnreachable>()(
  "ProviderUnreachable",
  {
    message: Schema.String,
  },
) {}

/**
 * The error codes a `ProviderRefused` may carry: the ones RFC 6749 section 5.2
 * defines, the ones RFC 8628 section 3.5 adds for the device flow, and the two
 * GitHub's device flow adds. Any other code is provider text and is dropped.
 */
const STANDARD_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "device_flow_disabled",
  "incorrect_client_credentials",
  "incorrect_device_code",
]);

/**
 * The longest `expires_in` a token endpoint may answer with: ten years, in
 * seconds. A larger value is a mistake or an attack, and it would not even
 * convert to a date.
 */
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

/** The standard token response. Any other fields the provider adds are ignored. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  token_type: Schema.optionalKey(Schema.String),
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

/** The standard error response (RFC 6749 section 5.2, and RFC 8628 section 3.5 for `interval`). */
const ErrorResponse = Schema.Struct({
  error: Schema.String,
  interval: Schema.optionalKey(Schema.Number),
});

const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

const failProviderUnreachable = (message: string): Effect.Effect<never, ProviderUnreachable> =>
  Effect.fail(new ProviderUnreachable({ message }));

/**
 * The stored token set does not hold a token set in the shape
 * `serializeTokens` writes. The message is fixed and never quotes the stored
 * value, because the stored value holds the tokens.
 */
export class StoredTokensUnreadable extends Schema.TaggedError<StoredTokensUnreadable>()(
  "StoredTokensUnreadable",
  { message: Schema.String },
) {}

/**
 * The schema of a `TokenSet`. A secret that embeds a token set decodes it with
 * this schema, so that a field added to `TokenSet` is never dropped on the way
 * through that secret.
 */
export const TokenSetSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  obtainedAt: Schema.optionalKey(Schema.String),
});

/** A token set as `serializeTokens` writes it: a JSON object in the shape of `TokenSet`. */
const StoredTokenSet = Schema.fromJsonString(TokenSetSchema);

const decodeStoredTokenSet = Schema.decodeUnknownEffect(StoredTokenSet);

/**
 * Parses a stored token set. Fails with `StoredTokensUnreadable` when the
 * value is not JSON, or not in the shape of a token set.
 *
 * Only this module writes token sets, so a value that does not parse means the
 * database is broken. The parse error is dropped rather than wrapped: both a
 * JSON syntax error and a schema error quote the text they failed on, which
 * here is a token.
 */
export const parseTokens = (stored: string): Effect.Effect<TokenSet, StoredTokensUnreadable> =>
  decodeStoredTokenSet(stored).pipe(
    Effect.mapError(
      () =>
        new StoredTokensUnreadable({ message: "this connection's stored tokens cannot be read" }),
    ),
  );

/** Converts a token set to the text `parseTokens` reads. */
export const serializeTokens = (tokens: TokenSet): string => JSON.stringify(tokens);

/**
 * Checks whether the access token needs a refresh: the time left is at most
 * the smaller of the refresh margin (10 minutes) and half of the token's
 * lifetime. A token that never expires is never stale.
 *
 * The margin depends on the lifetime because a provider may issue tokens that
 * live 10 minutes or less. With a fixed margin, every token such a provider
 * issues would be stale the moment it arrives, and a caller would refresh
 * again and again. With half the lifetime as the limit, a token just obtained
 * is never stale, and it is still renewed before it expires.
 *
 * A set without `obtainedAt` was stored before the field existed, and keeps
 * the fixed margin.
 */
export const isStale = (tokens: TokenSet, nowMillis: number): boolean => {
  if (tokens.expiresAt === undefined) return false;
  const expiresAtMillis = Date.parse(tokens.expiresAt);
  const margin =
    tokens.obtainedAt === undefined
      ? REFRESH_MARGIN_MS
      : Math.min(REFRESH_MARGIN_MS, (expiresAtMillis - Date.parse(tokens.obtainedAt)) / 2);
  return expiresAtMillis - nowMillis <= margin;
};

/** Checks whether the access token has expired, so that the provider would refuse it. */
export const isExpired = (tokens: TokenSet, nowMillis: number): boolean =>
  tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) <= nowMillis;

/** Computes the PKCE challenge for a verifier: its SHA-256 hash, base64url-encoded. */
export const computeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * Reads the body of an answer as text, and fails with `ProviderUnreachable`
 * once it passes `maxBytes` (`MAX_ANSWER_BYTES` unless given). It reads as the
 * body arrives, so a body with no `Content-Length` is never buffered past the
 * limit. The message names `endpointName` and the limit, never what was read.
 */
export const readBoundedText = (
  response: HttpClientResponse.HttpClientResponse,
  endpointName: string,
  maxBytes: number = MAX_ANSWER_BYTES,
): Effect.Effect<string, ProviderUnreachable | HttpClientError.HttpClientError> => {
  const tooLarge = () =>
    failProviderUnreachable(
      `the ${endpointName} answered with more than ${String(maxBytes)} bytes`,
    );
  if (Number(response.headers["content-length"] ?? 0) > maxBytes) return tooLarge();
  return Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.byteLength;
        if (total > maxBytes) return tooLarge();
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    return Buffer.concat(chunks).toString("utf8");
  });
};

/**
 * Sends a form-encoded request to one of the provider's OAuth endpoints, and
 * returns the response body when it is not an OAuth error.
 *
 * - Fails with `ProviderRefused` when the body is an OAuth error, whatever the
 *   status, or when the status is any other client error.
 * - Fails with `ProviderUnreachable` when the endpoint cannot be reached, answers
 *   with a redirect, answers with a server error, answers with a body that is
 *   not JSON or is over `MAX_ANSWER_BYTES`, or answers 403 or 429 with no
 *   OAuth error.
 *
 * A redirect is never followed: the form holds a secret (a client secret, a
 * refresh token, a code or a device code), and a 307 or 308 makes a client
 * send the same form to whatever address the response names.
 *
 * The request lives in a scope that ends with this call, and closing the scope
 * aborts the request. A body that was not read to its end (a redirect, a
 * server error, a refused size) is cancelled, so no connection stays open.
 *
 * `endpointName` names the endpoint in the error messages. No message holds
 * text the provider sent: a `ProviderRefused` names the provider's error code
 * only when it is one of `STANDARD_ERROR_CODES`.
 */
export const postForm = (
  url: string,
  form: Record<string, string>,
  endpointName: string,
  headers: Record<string, string> = {},
): Effect.Effect<unknown, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
      const response = yield* client
        .post(url, {
          body: HttpBody.urlParams(form),
          acceptJson: true,
          headers,
        })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const status = String(response.status);
      if (response.status >= 300 && response.status < 400) {
        return yield* failProviderUnreachable(
          `the ${endpointName} answered with a redirect, which is not followed`,
        );
      }
      if (response.status >= 500) {
        return yield* failProviderUnreachable(`the ${endpointName} returned HTTP ${status}`);
      }
      const text = yield* readBoundedText(response, endpointName);
      let body: unknown;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        if (response.status === 200) {
          return yield* failProviderUnreachable(
            `the ${endpointName} returned a response that is not JSON`,
          );
        }
      }
      const refusal = decodeErrorResponse(body);
      if (Option.isSome(refusal)) {
        const { error, interval } = refusal.value;
        const code = STANDARD_ERROR_CODES.has(error) ? error : undefined;
        return yield* Effect.fail(
          new ProviderRefused({
            message:
              code === undefined
                ? `the ${endpointName} refused the request`
                : `the ${endpointName} refused the request: ${code}`,
            ...(code === undefined ? {} : { code }),
            ...(interval === undefined ? {} : { interval }),
          }),
        );
      }
      // A 403 or 429 with no OAuth error is a rate limit or a temporary block,
      // as GitHub sends when a client polls too often. It says nothing about the
      // request itself, so the same request may work later.
      if (response.status === 403 || response.status === 429) {
        return yield* failProviderUnreachable(
          `the ${endpointName} returned HTTP ${status}: it is rate limiting requests or is ` +
            "temporarily unavailable",
        );
      }
      if (response.status !== 200) {
        return yield* Effect.fail(
          new ProviderRefused({ message: `the ${endpointName} returned HTTP ${status}` }),
        );
      }
      return body;
    }),
  ).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failProviderUnreachable(`the ${endpointName} could not be reached: ${error.message}`),
    ),
  );

/**
 * Sends a form-encoded request to the token endpoint, as every grant type
 * does, and returns the token set.
 *
 * Fails as `postForm` does, and with `ProviderUnreachable` when the response is
 * neither tokens nor an error, when its `expires_in` is not a whole number of
 * seconds from 0 to ten years, or, with `bearerOnly`, when its `token_type` is
 * present and is not `Bearer` (any letter case). `expires_in` is converted to
 * a timestamp here, because it counts from the moment of the response, and
 * that moment is stored as `obtainedAt`. A token without `expires_in` never
 * expires, and is stored with neither. A provider whose tokens do not expire
 * sends none.
 *
 * `bearerOnly` is for a caller that sends the token as `Authorization: Bearer`
 * and would otherwise send a token of another type as if it were a bearer one.
 * An answer with no `token_type` is accepted, because many providers leave it
 * out.
 */
export const requestTokens = (
  tokenUrl: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
  { bearerOnly = false }: { readonly bearerOnly?: boolean } = {},
): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = yield* decodeTokenResponse(
      yield* postForm(tokenUrl, form, "token endpoint", headers),
    ).pipe(
      Effect.catchTag("SchemaError", () =>
        failProviderUnreachable("the token endpoint's response has no access token"),
      ),
    );
    if (
      body.expires_in !== undefined &&
      !(
        Number.isInteger(body.expires_in) &&
        body.expires_in >= 0 &&
        body.expires_in <= MAX_EXPIRES_IN_SECONDS
      )
    ) {
      return yield* failProviderUnreachable(
        "the token endpoint's response has an expires_in that is not a lifetime in seconds",
      );
    }
    if (bearerOnly && body.token_type !== undefined && body.token_type.toLowerCase() !== "bearer") {
      return yield* failProviderUnreachable(
        "the token endpoint's response holds a token that is not a bearer token",
      );
    }
    const millis = yield* Clock.currentTimeMillis;
    return {
      accessToken: body.access_token,
      ...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
      ...(body.expires_in === undefined
        ? {}
        : {
            expiresAt: new Date(millis + body.expires_in * 1000).toISOString(),
            obtainedAt: new Date(millis).toISOString(),
          }),
    };
  });

/** Encodes a value as `application/x-www-form-urlencoded` does (RFC 6749 appendix B). */
const encodeFormComponent = (value: string): string =>
  new URLSearchParams({ v: value }).toString().slice("v=".length);

/**
 * Builds the part of a token request that identifies the client: the form
 * fields and the headers, as the client's auth method needs them. The
 * `client_id` is a field for every method except `client_secret_basic`, which
 * carries it in the header.
 */
const buildClientAuthentication = (
  client: OAuthClient,
): { readonly form: Record<string, string>; readonly headers: Record<string, string> } => {
  const { clientId, clientSecret } = client;
  if (clientSecret === undefined || client.authMethod === "none") {
    return { form: { client_id: clientId }, headers: {} };
  }
  if (client.authMethod === "client_secret_basic") {
    const credentials = `${encodeFormComponent(clientId)}:${encodeFormComponent(clientSecret)}`;
    return {
      form: {},
      headers: { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` },
    };
  }
  return { form: { client_id: clientId, client_secret: clientSecret }, headers: {} };
};

/**
 * Exchanges the authorization code for a token set, sending the PKCE verifier
 * as proof. The client authenticates as its `authMethod` says, so a public
 * client sends no secret. `resource` is the address of the server the token is
 * for (RFC 8707), and is sent only when given. `bearerOnly` is as in
 * `requestTokens`.
 */
export const exchangeCode = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly resource?: string;
  readonly bearerOnly?: boolean;
}): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> => {
  const authentication = buildClientAuthentication(request.client);
  return requestTokens(
    request.tokenUrl,
    {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      ...authentication.form,
      code_verifier: request.codeVerifier,
      ...(request.resource === undefined ? {} : { resource: request.resource }),
    },
    authentication.headers,
    { bearerOnly: request.bearerOnly === true },
  );
};

/**
 * How long the token endpoint has to answer a refresh. A refresh holds the
 * owner's one-at-a-time lock and, once sent, runs to its end even when its
 * caller is cancelled (see `renewTokenSet`), so a provider that never answers
 * needs a limit of its own.
 */
export const REFRESH_TIMEOUT_SECONDS = 30;

/**
 * Exchanges the refresh token for a new token set. The client authenticates as
 * its `authMethod` says, so a public client sends no secret. `resource` and
 * `bearerOnly` are as in `exchangeCode`. When the response has no new refresh token, the old one
 * is still valid, and the caller keeps it.
 *
 * Fails with `ProviderUnreachable` when the endpoint has not answered within
 * `REFRESH_TIMEOUT_SECONDS`. The request stays interruptible even when the
 * caller runs this effect uninterruptibly, so that the timeout can cancel it.
 */
export const refreshAccess = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly refreshToken: string;
  readonly resource?: string;
  readonly bearerOnly?: boolean;
}): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> => {
  const authentication = buildClientAuthentication(request.client);
  return requestTokens(
    request.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      ...authentication.form,
      ...(request.resource === undefined ? {} : { resource: request.resource }),
    },
    authentication.headers,
    { bearerOnly: request.bearerOnly === true },
  ).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: Duration.seconds(REFRESH_TIMEOUT_SECONDS),
      orElse: () =>
        failProviderUnreachable(
          `the token endpoint did not answer within ${String(REFRESH_TIMEOUT_SECONDS)} seconds`,
        ),
    }),
  );
};
