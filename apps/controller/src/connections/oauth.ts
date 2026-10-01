/**
 * The core's OAuth2 client: the parts of the authorization-code flow that are
 * the same for every provider, so a plugin that declares a connection type
 * implements none of them.
 *
 * This module holds the protocol:
 *
 * - building the authorization URL;
 * - decoding the query the browser comes back with;
 * - requesting tokens from the token endpoint;
 * - storing a token set and deciding when it needs a refresh.
 *
 * The flow itself (starting it, handling the callback, writing the connection)
 * is in the connection service. The refresh that a plugin's `credentials()`
 * call triggers is in `./runtime`. Both call into this module.
 *
 * The client credentials belong to the plugin that owns the connection type:
 * the client id is a field of the plugin's config, and the client secret is a
 * secret the plugin owns, both under fixed names. Each type belongs to one
 * plugin, so each type has exactly one client id and secret.
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
import type { OAuthDeclaration } from "@hercule/plugin-host";
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
 * The token endpoint returned a status other than 200. The code or refresh
 * token that was sent is treated as the problem.
 */
export class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {
  message: Schema.String,
}) {}

/**
 * The token endpoint could not be reached, or its response had no access
 * token. This error says nothing about the credential: a DNS failure or a
 * dropped network is not something the user can fix by reconnecting.
 */
export class TokenUnreachable extends Schema.TaggedError<TokenUnreachable>()("TokenUnreachable", {
  message: Schema.String,
}) {}

/** The standard token response. Any other fields the provider adds are ignored. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const failTokenRefused = (message: string): Effect.Effect<never, TokenRefused> =>
  Effect.fail(new TokenRefused({ message }));

const failTokenUnreachable = (message: string): Effect.Effect<never, TokenUnreachable> =>
  Effect.fail(new TokenUnreachable({ message }));

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
 * Sends a form-encoded request to the token endpoint, as both grant types do,
 * and returns the token set.
 *
 * Fails with `TokenRefused` when the status is not 200, and with
 * `TokenUnreachable` when the endpoint cannot be reached or returns no access
 * token. `expires_in` is converted to a timestamp here, because it counts from
 * the moment of the response.
 */
const requestTokens = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(tokenUrl, {
      body: HttpBody.urlParams(form),
      acceptJson: true,
    });
    if (response.status !== 200) {
      return yield* failTokenRefused(`the token endpoint returned HTTP ${String(response.status)}`);
    }
    const body = yield* decodeTokenResponse(yield* response.json).pipe(
      Effect.catchTag("SchemaError", () =>
        failTokenUnreachable("the token endpoint's response has no access token"),
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
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failTokenUnreachable(`the token endpoint could not be reached: ${error.message}`),
    ),
  );

/** Exchanges the authorization code for a token set, sending the PKCE verifier as proof. */
export const exchangeCode = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
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
}): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
  requestTokens(request.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
  });
