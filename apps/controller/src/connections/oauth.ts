/**
 * The core's OAuth2 client: the parts of the two token flows that are the same
 * for every provider, so a plugin that declares a connection type implements
 * none of them.
 *
 * - The redirect flow (authorization code with PKCE, RFC 6749 and RFC 7636)
 *   sends the browser to the provider and back to the controller.
 * - The device flow (RFC 8628) shows the user a code to enter at the provider,
 *   and the controller polls the token endpoint until the user approves.
 *
 * This module holds the protocol:
 *
 * - building the authorization URL;
 * - decoding the query the browser comes back with;
 * - requesting a device code, and exchanging it for tokens;
 * - requesting tokens from the token endpoint;
 * - storing a token set and deciding when it needs a refresh.
 *
 * The flows themselves (starting them, handling the callback or the poll,
 * writing the connection) are in the connection service. The refresh that a
 * plugin's `credentials()` call triggers is in `./runtime`. Both call into
 * this module.
 *
 * The redirect flow's client credentials belong to the plugin that owns the
 * connection type: the client id is a field of the plugin's config, and the
 * client secret is a secret the plugin owns, both under fixed names. Each type
 * belongs to one plugin, so each type has exactly one client id and secret.
 * The device flow needs no client secret: its client id is public, and the
 * type declares it.
 */
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { DeviceDeclaration, OAuthDeclaration } from "@hercule/plugin-host";
import { Secrets } from "../secrets";
import { PluginConfigs } from "./plugin-configs";

/** Where the provider sends the browser back to. Appended to the browser's origin. */
export const CALLBACK_PATH = "/oauth/callback";

/** The name of the only secret an OAuth connection owns: its whole token set, as JSON. */
export const OAUTH_TOKENS = "oauth.tokens";

/**
 * How long a started flow stays valid: long enough to read a provider's consent
 * screen, and short enough that abandoned flows are soon deleted.
 */
export const SETUP_LIFETIME_MS = 10 * 60 * 1000;

/**
 * How an OAuth flow ended, as the word the Connections screen receives in its
 * URL. The user only ever sees one of these five outcomes, never the
 * provider's own error message, which the controller does not put in a URL.
 */
export type Outcome = "ok" | "denied" | "expired" | "exchange-failed" | "rejected";

/** The query string the browser brings to the callback. */
const CallbackQuery = Schema.Struct({
  state: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export const decodeCallback = Schema.decodeUnknownEffect(CallbackQuery);

/** Computes the PKCE challenge for a verifier: its SHA-256 hash, base64url-encoded. */
export const computeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** Builds the authorization URL, with the parameters RFC 6749 and RFC 7636 define. */
export const buildAuthorizationUrl = (
  oauth: OAuthDeclaration,
  parts: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
  },
): string => {
  const url = new URL(oauth.authorizationUrl);
  const query: Record<string, string> = {
    // The type's extra parameters go first, so they cannot override a
    // parameter the protocol needs.
    ...(oauth.extraParams ?? {}),
    response_type: "code",
    client_id: parts.clientId,
    redirect_uri: parts.redirectUri,
    scope: oauth.scopes.join(" "),
    state: parts.state,
    code_challenge: parts.challenge,
    code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
};

/** The plugin config field and the plugin-owned secret that hold the client credentials. */
const CLIENT_ID_FIELD = "clientId";
const CLIENT_SECRET_NAME = "clientSecret";

/**
 * A token is refreshed this long before it expires, so a call that takes a
 * moment to reach the provider does not arrive with an expired token.
 */
const REFRESH_MARGIN_MS = 60_000;

/** The tokens the provider issued, as stored in the `oauth.tokens` secret. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

/** The OAuth client credentials of the plugin that owns a connection type. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * The provider refused the request: the code, refresh token or device code
 * that was sent is treated as the problem. `code` is the OAuth error code the
 * provider answered with, such as `invalid_grant` or `authorization_pending`,
 * and is absent when the provider sent a client error with no code.
 * `interval` is the new polling interval in seconds, which a provider may send
 * with `slow_down`.
 *
 * A provider may send an error with status 200 rather than 400, as GitHub
 * does. The body decides, not the status.
 */
export class ProviderRefused extends Schema.TaggedError<ProviderRefused>()("ProviderRefused", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Number),
}) {}

/**
 * The provider could not be reached, failed with a server error, or answered
 * with a body that is neither tokens nor an OAuth error. This error says
 * nothing about the credential: a DNS failure or a dropped network is not
 * something the user can fix by reconnecting.
 */
export class ProviderUnreachable extends Schema.TaggedError<ProviderUnreachable>()(
  "ProviderUnreachable",
  {
    message: Schema.String,
  },
) {}

/** The standard token response. Any other fields the provider adds are ignored. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

/** The standard error response (RFC 6749 section 5.2, and RFC 8628 section 3.5 for `interval`). */
const ErrorResponse = Schema.Struct({
  error: Schema.String,
  interval: Schema.optionalKey(Schema.Number),
});

const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

/** The device authorization response (RFC 8628 section 3.2). */
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optionalKey(Schema.Number),
});

const decodeDeviceCodeResponse = Schema.decodeUnknownEffect(DeviceCodeResponse);

const failProviderUnreachable = (message: string): Effect.Effect<never, ProviderUnreachable> =>
  Effect.fail(new ProviderUnreachable({ message }));

/** The redirect URI the provider will send the browser back to, for this origin. */
export const buildRedirectUri = (origin: string): string => `${origin}${CALLBACK_PATH}`;

/**
 * The `oauth.tokens` secret of a connection does not hold a token set in the
 * shape `serializeTokens` writes. The message is fixed and never quotes the
 * stored value, because the stored value holds the tokens.
 */
export class StoredTokensUnreadable extends Schema.TaggedError<StoredTokensUnreadable>()(
  "StoredTokensUnreadable",
  { message: Schema.String },
) {}

/** A token set as `serializeTokens` writes it: a JSON object in the shape of `TokenSet`. */
const StoredTokenSet = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.optionalKey(Schema.String),
    expiresAt: Schema.optionalKey(Schema.String),
  }),
);

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

export const serializeTokens = (tokens: TokenSet): string => JSON.stringify(tokens);

/** Checks whether the access token expires within the refresh margin, and so needs a refresh. */
export const isStale = (tokens: TokenSet, nowMillis: number): boolean =>
  tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - nowMillis <= REFRESH_MARGIN_MS;

/**
 * Returns a function that reads a plugin's OAuth client credentials. The
 * function returns `None` when the user has not set both the client id and the
 * client secret. It reads them on every call rather than once at registration,
 * because the user sets them in Settings after the plugin has declared its type.
 */
export const oauthClients: Effect.Effect<
  (pluginId: string) => Effect.Effect<Option.Option<OAuthClient>, SqlError>,
  never,
  PluginConfigs | Secrets
> = Effect.gen(function* () {
  const plugins = yield* PluginConfigs;
  const secrets = yield* Secrets;

  return (pluginId: string) =>
    Effect.gen(function* () {
      const config = yield* plugins.of(pluginId);
      const clientId = (config as { readonly [key: string]: unknown } | null)?.[CLIENT_ID_FIELD];
      const secret = yield* Effect.orDie(
        secrets.get({ kind: "plugin", id: pluginId }, CLIENT_SECRET_NAME),
      );
      return typeof clientId === "string" && clientId !== "" && Option.isSome(secret)
        ? Option.some({ clientId, clientSecret: Redacted.value(secret.value) })
        : Option.none();
    });
});

/**
 * Sends a form-encoded request to one of the provider's OAuth endpoints, and
 * returns the response body when it is not an OAuth error.
 *
 * - Fails with `ProviderRefused` when the body is an OAuth error, whatever the
 *   status, or when the status is any other client error.
 * - Fails with `ProviderUnreachable` when the endpoint cannot be reached, answers
 *   with a server error, or answers with a body that is not JSON.
 *
 * `endpoint` names the endpoint in the error messages.
 */
const postForm = (
  url: string,
  form: Record<string, string>,
  endpoint: string,
): Effect.Effect<unknown, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(url, {
      body: HttpBody.urlParams(form),
      acceptJson: true,
    });
    const status = String(response.status);
    if (response.status >= 500) {
      return yield* failProviderUnreachable(`the ${endpoint} returned HTTP ${status}`);
    }
    const body = yield* Effect.catch(response.json, () =>
      response.status === 200
        ? failProviderUnreachable(`the ${endpoint} returned a response that is not JSON`)
        : Effect.succeed(undefined),
    );
    const refusal = decodeErrorResponse(body);
    if (Option.isSome(refusal)) {
      return yield* Effect.fail(
        new ProviderRefused({
          message: `the ${endpoint} refused the request: ${refusal.value.error}`,
          code: refusal.value.error,
          ...(refusal.value.interval === undefined ? {} : { interval: refusal.value.interval }),
        }),
      );
    }
    if (response.status !== 200) {
      return yield* Effect.fail(
        new ProviderRefused({ message: `the ${endpoint} returned HTTP ${status}` }),
      );
    }
    return body;
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failProviderUnreachable(`the ${endpoint} could not be reached: ${error.message}`),
    ),
  );

/**
 * Sends a form-encoded request to the token endpoint, as every grant type
 * does, and returns the token set.
 *
 * Fails as `postForm` does, and with `ProviderUnreachable` when the response is
 * neither tokens nor an error. `expires_in` is converted to a timestamp here,
 * because it counts from the moment of the response. A token without
 * `expires_in`, such as a GitHub OAuth App token, never expires, and is stored
 * without `expiresAt`.
 */
const requestTokens = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = yield* decodeTokenResponse(yield* postForm(tokenUrl, form, "token endpoint")).pipe(
      Effect.catchTag("SchemaError", () =>
        failProviderUnreachable("the token endpoint's response has no access token"),
      ),
    );
    const millis = yield* Clock.currentTimeMillis;
    return {
      accessToken: body.access_token,
      ...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
      ...(body.expires_in === undefined
        ? {}
        : { expiresAt: new Date(millis + body.expires_in * 1000).toISOString() }),
    };
  });

/** Exchanges the authorization code for a token set, sending the PKCE verifier as proof. */
export const exchangeCode = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  requestTokens(request.tokenUrl, {
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
    code_verifier: request.codeVerifier,
  });

/**
 * Exchanges the refresh token for a new token set. When the response has no
 * new refresh token, the old one is still valid, and the caller keeps it.
 */
export const refreshAccess = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly refreshToken: string;
}): Effect.Effect<TokenSet, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  requestTokens(request.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
  });

/** The grant type a device code is exchanged with (RFC 8628 section 3.4). */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The polling interval, in seconds, when the provider names none (RFC 8628 section 3.2). */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * How many seconds a `slow_down` adds to the polling interval when the
 * provider names no new interval (RFC 8628 section 3.5).
 */
export const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * Converts an interval the provider sent into whole seconds of at least one,
 * the form the contract carries it in.
 */
const toPollInterval = (seconds: number): number => Math.max(1, Math.ceil(seconds));

/** A device code the provider issued, and what the user needs to approve it. */
export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds until the device code expires. */
  readonly expiresIn: number;
  /** Seconds to wait between two polls of the token endpoint. */
  readonly interval: number;
}

/**
 * Asks the provider's device authorization endpoint for a device code. Fails
 * with `ProviderRefused` when the provider refuses, for example because device
 * flow is disabled on its OAuth app, and with `ProviderUnreachable` when it
 * cannot be reached or its answer has no device code.
 */
export const requestDeviceCode = (
  device: DeviceDeclaration,
): Effect.Effect<DeviceCode, ProviderRefused | ProviderUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const answer = yield* postForm(
      device.deviceCodeUrl,
      { client_id: device.clientId, scope: device.scopes.join(" ") },
      "device authorization endpoint",
    );
    const body = yield* decodeDeviceCodeResponse(answer).pipe(
      Effect.catchTag("SchemaError", () =>
        failProviderUnreachable("the device authorization endpoint's response has no device code"),
      ),
    );
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in,
      interval: toPollInterval(body.interval ?? DEFAULT_POLL_INTERVAL_SECONDS),
    };
  });

/**
 * What one exchange of a device code returned.
 *
 * - `done`: the user approved, and the provider issued tokens.
 * - `pending`: the user has not approved yet.
 * - `slow-down`: the provider asked for slower polling. `interval` is the new
 *   interval it named, or `undefined` when it named none.
 * - `expired`, `denied`, `failed`: the provider ended the flow. `message`
 *   says why, in words the user can read.
 * - `unreachable`: the provider could not be reached this time.
 */
export type DeviceExchange =
  | { readonly status: "done"; readonly tokens: TokenSet }
  | { readonly status: "pending" }
  | { readonly status: "slow-down"; readonly interval: number | undefined }
  | {
      readonly status: "expired" | "denied" | "failed" | "unreachable";
      readonly message: string;
    };

/** Converts the provider's refusal of a device code exchange into the exchange's result. */
const decideDeviceRefusal = (refusal: ProviderRefused): DeviceExchange => {
  switch (refusal.code) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return {
        status: "slow-down",
        interval: refusal.interval === undefined ? undefined : toPollInterval(refusal.interval),
      };
    case "expired_token":
      return { status: "expired", message: "the code expired before it was approved" };
    case "access_denied":
      return { status: "denied", message: "the request was declined at the provider" };
    default:
      // Every other code, such as `incorrect_client_credentials` or
      // `device_flow_disabled`, is a problem with the type's OAuth app rather
      // than with this flow. The code is the most precise thing to show.
      return {
        status: "failed",
        message:
          refusal.code === undefined
            ? refusal.message
            : `the provider refused the device flow with the error ${refusal.code}`,
      };
  }
};

/**
 * Exchanges a device code for a token set, once. Never fails: every way the
 * exchange can end, including an unreachable provider, is a `DeviceExchange`,
 * because the caller answers each of them to the user. No client secret is
 * sent, because the device flow has none.
 */
export const exchangeDeviceCode = (
  device: DeviceDeclaration,
  deviceCode: string,
): Effect.Effect<DeviceExchange, never, HttpClient.HttpClient> =>
  requestTokens(device.tokenUrl, {
    client_id: device.clientId,
    device_code: deviceCode,
    grant_type: DEVICE_CODE_GRANT,
  }).pipe(
    Effect.map((tokens): DeviceExchange => ({ status: "done", tokens })),
    Effect.catchTag("ProviderRefused", (refusal) => Effect.succeed(decideDeviceRefusal(refusal))),
    Effect.catchTag("ProviderUnreachable", (error) =>
      Effect.succeed<DeviceExchange>({ status: "unreachable", message: error.message }),
    ),
  );
