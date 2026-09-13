/**
 * The core's OAuth2 client: the parts of an authorization-code flow that are
 * the same for every provider, so a plugin declaring a type writes none of it.
 *
 * What is here is what talks to a token endpoint and what a token set is worth
 * once it is stored. The flow itself - the start, the callback, the connection
 * it creates - is the connection service's, and the refresh a plugin triggers
 * is the plugin host's; both call in here.
 *
 * Client credentials are the owning plugin's: the id is a field of its config
 * and the secret is one it owns, under fixed names. A type is one plugin's, so
 * there is exactly one pair per type and nothing to choose between.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
// The table accessor rather than the plugins domain's boundary: the plugin host
// reads this domain, so importing its index would close a cycle. All that is
// wanted here is one column of one row - the client id the user configured.
import { pluginRepository } from "../plugins/repository";
import { Secrets } from "../secrets";

/** Where the provider sends the browser back to. Appended to the browser's origin. */
export const CALLBACK_PATH = "/oauth/callback";

/** The one secret an OAuth connection owns: its whole token set, as JSON. */
export const OAUTH_TOKENS = "oauth.tokens";

/** The plugin config field and the plugin-owned secret that hold the client credentials. */
const CLIENT_ID_FIELD = "clientId";
const CLIENT_SECRET_NAME = "clientSecret";

/**
 * A token is refreshed this long before it runs out, so a call that takes a
 * moment to reach the provider is not made with a token that expires on the way.
 */
const REFRESH_MARGIN_MS = 60_000;

/** What the provider gave us, as the `oauth.tokens` secret holds it. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

/** The client credentials the plugin that owns a type holds. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The token endpoint could not be reached, refused, or answered nonsense. */
export class TokenRequestFailed extends Schema.TaggedError<TokenRequestFailed>()(
  "TokenRequestFailed",
  { message: Schema.String },
) {}

/** The standard token response. Anything else the provider adds is not ours to read. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const failed = (message: string): Effect.Effect<never, TokenRequestFailed> =>
  Effect.fail(new TokenRequestFailed({ message }));

/** The redirect URI the provider will send the browser back to, for this origin. */
export const redirectUri = (origin: string): string => `${origin}${CALLBACK_PATH}`;

/** Written by this module alone, so a token set that does not parse is a broken database. */
export const parseTokens = (stored: string): TokenSet => JSON.parse(stored) as TokenSet;

export const serializeTokens = (tokens: TokenSet): string => JSON.stringify(tokens);

/** Whether this token is too close to running out to be worth handing over. */
export const isStale = (tokens: TokenSet, nowMillis: number): boolean =>
  tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - nowMillis <= REFRESH_MARGIN_MS;

/**
 * Reads the client credentials a plugin holds, or nothing when the user has not
 * set both. Built once and read at each call rather than at registration: the
 * user sets them in Settings long after the plugin declared its type.
 */
export const oauthClients: Effect.Effect<
  (pluginId: string) => Effect.Effect<Option.Option<OAuthClient>, SqlError>,
  never,
  SqlClient.SqlClient | Secrets
> = Effect.gen(function* () {
  const plugins = yield* pluginRepository;
  const secrets = yield* Secrets;

  return (pluginId: string) =>
    Effect.gen(function* () {
      const state = yield* Effect.catchTag(plugins.state(pluginId), "SchemaError", Effect.die);
      const clientId = (state.config as { readonly [key: string]: unknown } | null)?.[
        CLIENT_ID_FIELD
      ];
      const secret = yield* Effect.orDie(
        secrets.get({ kind: "plugin", id: pluginId }, CLIENT_SECRET_NAME),
      );
      return typeof clientId === "string" && clientId !== "" && Option.isSome(secret)
        ? Option.some({ clientId, clientSecret: Redacted.value(secret.value) })
        : Option.none();
    });
});

/**
 * One form-encoded token request, as both grants make it. The answer's
 * `expires_in` is turned into an instant here, because that is the only moment
 * it can be read against.
 */
const tokenRequest = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<TokenSet, TokenRequestFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(tokenUrl, {
      body: HttpBody.urlParams(form),
      acceptJson: true,
    });
    if (response.status !== 200) {
      return yield* failed(`the token endpoint answered ${String(response.status)}`);
    }
    const body = yield* decodeTokenResponse(yield* response.json).pipe(
      Effect.catchTag("SchemaError", () => failed("the token endpoint answered no access token")),
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
      failed(`the token endpoint could not be reached: ${error.message}`),
    ),
  );

/** Spends the code the provider sent the browser back with, proving the PKCE verifier. */
export const exchangeCode = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Effect.Effect<TokenSet, TokenRequestFailed, HttpClient.HttpClient> =>
  tokenRequest(request.tokenUrl, {
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
    code_verifier: request.codeVerifier,
  });

/**
 * Trades the refresh token for a fresh access token. A provider that answers
 * without a new refresh token means the old one still stands, so the caller
 * keeps it.
 */
export const refreshAccess = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly refreshToken: string;
}): Effect.Effect<TokenSet, TokenRequestFailed, HttpClient.HttpClient> =>
  tokenRequest(request.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
  });
