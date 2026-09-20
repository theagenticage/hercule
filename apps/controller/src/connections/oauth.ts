/**
 * The core's OAuth2 client: the parts of an authorization-code flow that are
 * the same for every provider, so a plugin declaring a type writes none of it.
 *
 * What is here is the protocol: the authorization request, what the browser
 * comes back with, what talks to a token endpoint, and what a token set is
 * worth once it is stored. The flow itself - deciding a start, spending a
 * callback, writing the connection it creates - is the connection service's,
 * and the refresh a plugin triggers is the plugin host's; both call in here.
 *
 * Client credentials are the owning plugin's: the id is a field of its config
 * and the secret is one it owns, under fixed names. A type is one plugin's, so
 * there is exactly one pair per type and nothing to choose between.
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

/** The one secret an OAuth connection owns: its whole token set, as JSON. */
export const OAUTH_TOKENS = "oauth.tokens";

/** Long enough to read a provider's consent screen, short enough to be worth sweeping. */
export const SETUP_LIFETIME_MS = 10 * 60 * 1000;

/**
 * How a redirect flow ended, in the words the Connections screen reads. The set
 * is closed: what the user is told is one of these five and never a provider's
 * own message, which is not ours to put in a URL.
 */
export type Outcome = "ok" | "denied" | "expired" | "exchange-failed" | "rejected";

/** What the browser arrives at the callback with, straight off the query string. */
const CallbackQuery = Schema.Struct({
  state: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export const decodeCallback = Schema.decodeUnknownEffect(CallbackQuery);

/** The PKCE challenge: the verifier, hashed the way the provider will hash it. */
export const challengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** The authorization request, as RFC 6749 and RFC 7636 spell it. */
export const authorizationUrl = (
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
    // The type's own extras first, so nothing it asks for can displace a
    // parameter the protocol itself is carried by.
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

/**
 * The token endpoint answered, and said no. The credential it was asked about
 * is the thing that is wrong.
 */
export class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {
  message: Schema.String,
}) {}

/**
 * The token endpoint was not reached, or answered something unreadable. It says
 * nothing about the credential: a name that did not resolve and a network that
 * dropped are the provider's weather, not the user's to reauthorise.
 */
export class TokenUnreachable extends Schema.TaggedError<TokenUnreachable>()("TokenUnreachable", {
  message: Schema.String,
}) {}

/** The standard token response. Anything else the provider adds is not ours to read. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const refused = (message: string): Effect.Effect<never, TokenRefused> =>
  Effect.fail(new TokenRefused({ message }));

const unreachable = (message: string): Effect.Effect<never, TokenUnreachable> =>
  Effect.fail(new TokenUnreachable({ message }));

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
 * One form-encoded token request, as both grants make it. The answer's
 * `expires_in` is turned into an instant here, because that is the only moment
 * it can be read against.
 */
const tokenRequest = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(tokenUrl, {
      body: HttpBody.urlParams(form),
      acceptJson: true,
    });
    if (response.status !== 200) {
      return yield* refused(`the token endpoint answered ${String(response.status)}`);
    }
    const body = yield* decodeTokenResponse(yield* response.json).pipe(
      Effect.catchTag("SchemaError", () =>
        unreachable("the token endpoint answered no access token"),
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
      unreachable(`the token endpoint could not be reached: ${error.message}`),
    ),
  );

/** Spends the code the provider sent the browser back with, proving the PKCE verifier. */
export const exchangeCode = (request: {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
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
}): Effect.Effect<TokenSet, TokenRefused | TokenUnreachable, HttpClient.HttpClient> =>
  tokenRequest(request.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
    client_id: request.client.clientId,
    client_secret: request.client.clientSecret,
  });
