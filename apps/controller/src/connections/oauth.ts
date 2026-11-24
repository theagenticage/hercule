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
 * This module holds what is about a Connection:
 *
 * - building the authorization URL;
 * - decoding the query the browser comes back with;
 * - finding the client a type's redirect flow runs as;
 * - requesting a device code, and exchanging it for tokens.
 *
 * The token set, the requests to a token endpoint and the refresh are shared
 * with the MCP Servers and live in `../oauth`.
 *
 * The flows themselves (starting them, handling the callback or the poll,
 * writing the connection) are in the connection service. The refresh that a
 * plugin's `credentials()` call triggers is in `./runtime`. Both call into
 * this module.
 *
 * The redirect flow's client comes from one of three places:
 *
 * - A type whose `publicClient` declares a `clientId` uses the client id the
 *   plugin ships, with no client secret. The provider accepts the PKCE code
 *   verifier alone as proof.
 * - A type whose `publicClient` is `createdAtSetup` uses the client its
 *   plugin created for the Connection, also with no client secret. The
 *   Connection and the pending flow record the client's id.
 * - Any other type uses the client of the plugin that owns it: the client id
 *   is a field of the plugin's config, and the client secret is a secret the
 *   plugin owns, both under fixed names. Each type belongs to one plugin, so
 *   each type has exactly one client id and secret.
 *
 * The device flow needs no client secret either: its client id is public, and
 * the type declares it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import type { SqlError } from "effect/sql/SqlError";
import type { DeviceDeclaration, OAuthDeclaration } from "@hercule/plugin-host";
import {
  postForm,
  ProviderRefused,
  ProviderUnreachable,
  requestTokens,
  type OAuthClient,
  type TokenSet,
} from "../oauth";
import { Secrets } from "../secrets";
import { PluginConfigs } from "./plugin-configs";

/** Where the provider sends the browser back to. Appended to the browser's origin. */
export const CALLBACK_PATH = "/oauth/callback";

/** The path the desktop app's own return catcher listens on. */
export const CATCHER_PATH = "/callback";

/**
 * The paths a public client may register a redirect URI on: the controller's
 * callback path, and the path the desktop app's own catcher listens on.
 */
export const REDIRECT_URI_PATHS: ReadonlyArray<string> = [CALLBACK_PATH, CATCHER_PATH];

/** The name of the only secret an OAuth connection owns: its whole token set, as JSON. */
export const OAUTH_TOKENS = "oauth.tokens";

/**
 * How long a started flow stays valid: long enough to read a provider's consent
 * screen, and short enough that abandoned flows are soon deleted.
 */
export const SETUP_LIFETIME_MS = 10 * 60 * 1000;

/**
 * How long after a sign-in's lifetime the controller waits before it deletes
 * the OAuth client the sign-in created. A finish can claim the sign-in until
 * the last moment of its lifetime and then spends up to a minute on the code
 * exchange and the account check, and the timer must not delete the client
 * under it. The finish takes ownership of the cleanup in the same step as its
 * claim, so this grace only has to cover that one step.
 */
export const CREATED_CLIENT_GRACE_MS = 2 * 60 * 1000;

/**
 * How an OAuth flow ended, as the word the Connections screen receives in its
 * URL. The user only ever sees one of these six outcomes, never the
 * provider's own error message, which the controller does not put in a URL.
 *
 * `other-account` ends a reconnect whose sign-in was for another account
 * than the connection's own. The URL holds only this word, so the screen's
 * message cannot name the two accounts.
 */
export type Outcome =
  | "ok"
  | "denied"
  | "expired"
  | "exchange-failed"
  | "rejected"
  | "other-account";

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

/** The device authorization response (RFC 8628 section 3.2). */
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optionalKey(Schema.Number),
});

const decodeDeviceCodeResponse = Schema.decodeUnknownEffect(DeviceCodeResponse);

/** The redirect URI the provider will send the browser back to, for this origin. */
export const buildRedirectUri = (origin: string): string => `${origin}${CALLBACK_PATH}`;

/**
 * Checks whether a redirect URI is one a public client registered.
 *
 * - A registered URI matches the same URI exactly.
 * - A registered `http` loopback URI with no port also matches the same
 *   host and path on any port (RFC 8252 section 7.3), because a program on the
 *   user's machine picks a free port each time it listens. Slack registers
 *   its clients this way.
 * - A registered URI with a port matches only that port, because a provider
 *   such as Linear registered that exact address.
 *
 * `redirectUri` with a query, a fragment or user information never matches by
 * the any-port rule.
 */
export const isRegisteredRedirectUri = (registered: string, redirectUri: string): boolean => {
  if (registered === redirectUri) return true;
  const registeredUrl = URL.parse(registered);
  const returnUrl = URL.parse(redirectUri);
  if (registeredUrl === null || returnUrl === null) return false;
  // A URL with a port, even the default one, is written differently from its
  // scheme, host and path alone, so this tells "no port registered" from "port
  // 80 registered".
  const registeredWithoutPort =
    registeredUrl.protocol === "http:" &&
    registered === `${registeredUrl.protocol}//${registeredUrl.hostname}${registeredUrl.pathname}`;
  return (
    registeredWithoutPort &&
    returnUrl.protocol === "http:" &&
    returnUrl.hostname === registeredUrl.hostname &&
    returnUrl.pathname === registeredUrl.pathname &&
    returnUrl.search === "" &&
    returnUrl.hash === "" &&
    returnUrl.username === "" &&
    returnUrl.password === ""
  );
};

/**
 * Returns a function that finds the client a type's redirect flow runs as,
 * for both the code exchange and the refresh. `createdClientId` is the id of
 * the client the plugin created for the Connection or the flow, when there is
 * one.
 *
 * - For a type whose `publicClient` ships a `clientId`, the function returns
 *   it with no secret, and reads nothing from the plugin's settings.
 * - For a type whose `publicClient` is `createdAtSetup`, it returns
 *   `createdClientId` with no secret, or `None` when there is none.
 * - For any other type, it reads the client id and secret the user set for the
 *   plugin, and returns `None` when either is missing. It reads them on every
 *   call rather than once at registration, because the user sets them in
 *   Settings after the plugin has declared its type.
 */
export const oauthClients: Effect.Effect<
  (
    pluginId: string,
    oauth: OAuthDeclaration,
    createdClientId: string | undefined,
  ) => Effect.Effect<Option.Option<OAuthClient>, SqlError>,
  never,
  PluginConfigs | Secrets
> = Effect.gen(function* () {
  const plugins = yield* PluginConfigs;
  const secrets = yield* Secrets;

  return (pluginId: string, oauth: OAuthDeclaration, createdClientId: string | undefined) =>
    Effect.gen(function* () {
      if (oauth.publicClient !== undefined) {
        if ("clientId" in oauth.publicClient) {
          return Option.some<OAuthClient>({ clientId: oauth.publicClient.clientId });
        }
        return createdClientId === undefined
          ? Option.none()
          : Option.some<OAuthClient>({ clientId: createdClientId });
      }
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
 * Rounds an interval the provider sent up to whole seconds, and to at least
 * one second, the form the contract carries it in.
 */
const roundPollInterval = (seconds: number): number => Math.max(1, Math.ceil(seconds));

/**
 * The error code a provider sends when device flow is turned off on the OAuth
 * App, as GitHub does until the app's owner enables it.
 */
const DEVICE_FLOW_DISABLED = "device_flow_disabled";

/**
 * The message for a provider that has device flow turned off. The user cannot
 * change the OAuth App's settings, so the message points to the other way in.
 */
const DEVICE_FLOW_DISABLED_MESSAGE =
  "device flow is turned off on the provider's OAuth App for this type, so signing in " +
  "with a code cannot work: paste a token instead";

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
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "ProviderRefused" && error.code === DEVICE_FLOW_DISABLED
          ? new ProviderRefused({ message: DEVICE_FLOW_DISABLED_MESSAGE, code: error.code })
          : error,
      ),
    );
    const body = yield* decodeDeviceCodeResponse(answer).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new ProviderUnreachable({
            message: "the device authorization endpoint's response has no device code",
          }),
        ),
      ),
    );
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in,
      interval: roundPollInterval(body.interval ?? DEFAULT_POLL_INTERVAL_SECONDS),
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
        interval: refusal.interval === undefined ? undefined : roundPollInterval(refusal.interval),
      };
    case "expired_token":
      return { status: "expired", message: "the code expired before it was approved" };
    case "access_denied":
      return { status: "denied", message: "the request was declined at the provider" };
    case DEVICE_FLOW_DISABLED:
      return { status: "failed", message: DEVICE_FLOW_DISABLED_MESSAGE };
    default:
      // Every other code, such as `incorrect_client_credentials`, is a problem
      // with the type's OAuth app rather than with this flow. The code is the
      // most precise thing to show.
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
