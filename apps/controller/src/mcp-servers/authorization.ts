/**
 * Finds out how a server added by URL signs a user in, and registers Hercule
 * with the server's authorization server (spec 21 sections 5.2 and 5.6). It
 * only talks to the network and keeps no state: `discoverAuthorization` reads
 * the server's OAuth metadata (RFC 9728 and RFC 8414), and `registerClient`
 * registers a client with Dynamic Client Registration (RFC 7591).
 *
 * Every request follows the same outbound rules, because the addresses come
 * from servers that the user chose but did not write:
 *
 * - the address is http or https, holds no user name or password, and is
 *   https, except on the same host and port as an http MCP server (a server
 *   that signs its users in itself, in a private network). A code, a client secret or a
 *   token must never cross the network in clear text because a server's
 *   metadata said so;
 * - a redirect is a failure and is never followed;
 * - a request has 30 seconds, and an answer is read up to 1 MiB;
 * - the HTTP client records no trace span, because a span records the address
 *   and the error text;
 * - a failure has a fixed message and never quotes what the server sent.
 *
 * Two failures are told apart, because the user does something different
 * about each. `AuthorizationUnsupported` means the server offers no sign-in
 * through the browser that Hercule can use, so the user pastes a token.
 * `AuthorizationUnreadable` means the server or its authorization server could
 * not be reached or answered what OAuth does not allow, so the user tries
 * again later.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readBoundedText, type ClientAuthMethod, type OAuthClient } from "../oauth";

/** The most bytes read from one answer of a metadata or registration endpoint. */
const MAX_METADATA_BYTES = 1024 * 1024;

/** How long one request has to be answered, body included. */
const REQUEST_TIMEOUT_SECONDS = 30;

/** The furthest expiry of a client secret that is kept: ten years. A later one is read as no expiry. */
const MAX_SECRET_LIFETIME_MILLIS = 10 * 365 * 24 * 60 * 60 * 1000;

/** The MCP revision the unauthenticated probe says it speaks. */
const PROBE_PROTOCOL_VERSION = "2025-11-25";

/**
 * The redirect address Hercule registers: the loopback address with no port.
 * RFC 8252 section 7.3 says an authorization server accepts any port on a
 * loopback redirect, so one registration covers every port a sign-in listens
 * on. Notion and Linear were proven to do so.
 */
const REGISTERED_REDIRECT_URI = "http://127.0.0.1/callback";

/** What the longest scope Hercule sends may be. A longer one is not a scope. */
const MAX_SCOPE_LENGTH = 1024;

/** The characters of an OAuth scope (RFC 6749 section 3.3): tokens separated by single spaces. */
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/;

/**
 * The server offers no sign-in through the browser that Hercule can use: it
 * publishes no OAuth metadata, or its authorization server cannot sign
 * Hercule in (no registration endpoint, or no PKCE with S256). The message is
 * fixed and safe to show.
 */
export class AuthorizationUnsupported extends Schema.TaggedError<AuthorizationUnsupported>()(
  "AuthorizationUnsupported",
  { message: Schema.String },
) {}

/**
 * The server or its authorization server could not be reached, or answered
 * what OAuth does not allow (a redirect, a metadata document that breaks the
 * rules, an address that downgrades to http). Trying again later may work.
 * The message is fixed and safe to show: it never quotes the server.
 */
export class AuthorizationUnreadable extends Schema.TaggedError<AuthorizationUnreadable>()(
  "AuthorizationUnreadable",
  { message: Schema.String },
) {}

const failUnsupported = (message: string): Effect.Effect<never, AuthorizationUnsupported> =>
  Effect.fail(new AuthorizationUnsupported({ message }));

const failUnreadable = (message: string): Effect.Effect<never, AuthorizationUnreadable> =>
  Effect.fail(new AuthorizationUnreadable({ message }));

/** What an authorization server offers, as its metadata says (RFC 8414). */
export interface AuthorizationServer {
  /** The issuer identifier, exactly as the protected resource metadata names it. */
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** The Dynamic Client Registration endpoint, or `undefined` when the server offers none. */
  readonly registrationEndpoint: string | undefined;
  /** Whether the server promises to send `iss` on every authorization response (RFC 9207). */
  readonly sendsIssuer: boolean;
  /** The client authentication methods the token endpoint accepts, when it says. */
  readonly tokenEndpointAuthMethods: ReadonlyArray<string>;
}

/** What discovery found for one MCP server: its authorization server, its resource and the scope to ask for. */
export interface DiscoveredAuthorization extends AuthorizationServer {
  /** The resource identifier (RFC 8707) that the server's metadata gave, which every token request names. */
  readonly resource: string;
  /** The scope to ask for, or `undefined` to ask for none. */
  readonly scope: string | undefined;
}

/** A client registered with an authorization server. `authMethod` is how it signs its token requests. */
export interface RegisteredClient extends OAuthClient {
  readonly authMethod: ClientAuthMethod;
  /** When the client's secret stops working, as the registration answer states (RFC 7591), or `undefined` when it never does. */
  readonly secretExpiresAtMillis?: number;
}

/** What a `WWW-Authenticate` header's `Bearer` challenge says about OAuth. */
interface BearerChallenge {
  /** The address of the protected resource metadata (RFC 9728), when the challenge names one. */
  readonly resourceMetadata: string | undefined;
  /** The scope the challenge asks for, when it names one. */
  readonly scope: string | undefined;
}

/**
 * The longest `WWW-Authenticate` header that is read. A real challenge is a
 * few hundred bytes, and the header comes from a server the user did not
 * write, so a longer one counts as having no challenge.
 */
const MAX_CHALLENGE_LENGTH = 8 * 1024;

/** Checks whether `character` ends a token in a `WWW-Authenticate` header: a space, a tab, a comma, an equals sign or a quote. */
const endsChallengeToken = (character: string): boolean =>
  character === " " ||
  character === "\t" ||
  character === "," ||
  character === "=" ||
  character === '"';

/**
 * Reads the `resource_metadata` and `scope` parameters of the `Bearer`
 * challenge in a `WWW-Authenticate` header (RFC 9728 section 5.1, RFC 6750
 * section 3). A header may hold several challenges (`Basic realm="x", Bearer
 * scope="y"`), and a parameter counts only inside the `Bearer` one. Parameter
 * names are case-insensitive, and the first of a name wins. A quoted value is
 * read whole, so a comma or an `=` inside it is never read as structure.
 * Returns `undefined` for each that is absent, and for both when the header
 * itself is, or is longer than `MAX_CHALLENGE_LENGTH`.
 *
 * It reads the header in one pass from left to right, so its time is linear
 * in the length of the header, whatever the header holds.
 */
export const parseBearerChallenge = (header: string | undefined): BearerChallenge => {
  let resourceMetadata: string | undefined;
  let scope: string | undefined;
  if (header === undefined || header.length > MAX_CHALLENGE_LENGTH) {
    return { resourceMetadata, scope };
  }
  const skipBlanks = (from: number): number => {
    let at = from;
    while (header[at] === " " || header[at] === "\t") at += 1;
    return at;
  };
  let inBearerChallenge = false;
  let at = 0;
  while (at < header.length) {
    if (header[at] === " " || header[at] === "\t" || header[at] === ",") {
      at += 1;
      continue;
    }
    const nameStart = at;
    while (at < header.length && !endsChallengeToken(header[at]!)) at += 1;
    const name = header.slice(nameStart, at);
    if (name === "") {
      // A stray `=` or quote that no name leads: skip it.
      at += 1;
      continue;
    }
    const afterName = skipBlanks(at);
    if (header[afterName] !== "=") {
      // A bare word starts a challenge.
      inBearerChallenge = name.toLowerCase() === "bearer";
      continue;
    }
    at = skipBlanks(afterName + 1);
    let value = "";
    if (header[at] === '"') {
      at += 1;
      while (at < header.length && header[at] !== '"') {
        if (header[at] === "\\" && at + 1 < header.length) at += 1;
        value += header[at];
        at += 1;
      }
      at += 1;
    } else {
      const valueStart = at;
      // An unquoted value may hold `=`, as in an address with a query.
      while (at < header.length && !/[ \t,"]/.test(header[at]!)) at += 1;
      value = header.slice(valueStart, at);
    }
    if (inBearerChallenge) {
      const parameter = name.toLowerCase();
      if (parameter === "resource_metadata") resourceMetadata ??= value;
      if (parameter === "scope") scope ??= value;
    }
  }
  return { resourceMetadata, scope };
};

/** Returns the address as text without its fragment, which is never sent to a server. */
const withoutFragment = (address: URL): string => {
  const copy = new URL(address);
  copy.hash = "";
  return copy.href;
};

/**
 * An address where protected resource metadata may be, with the resource
 * identifier its `resource` field must equal (RFC 9728 section 3.3).
 */
interface ResourceMetadataCandidate {
  readonly url: string;
  readonly resource: string;
}

/**
 * Lists the addresses where a server's protected resource metadata may be, in
 * the order to try them (RFC 9728 section 3.1): the well-known address with
 * the server's path and query after it, then the well-known address of its
 * origin. Each comes with the identifier it was built from, which the
 * metadata's `resource` must equal: the server's address for the first, and
 * its origin for the second. A server whose path is only `/` has the first
 * address with no path, and when it has a query, the second is tried too,
 * because the metadata of such a server may be published for its origin.
 */
const buildResourceMetadataCandidates = (server: URL): ReadonlyArray<ResourceMetadataCandidate> => {
  const wellKnown = `${server.origin}/.well-known/oauth-protected-resource`;
  const path = server.pathname === "/" ? "" : server.pathname;
  const first = { url: `${wellKnown}${path}${server.search}`, resource: withoutFragment(server) };
  if (path === "" && server.search === "") return [first];
  return [first, { url: wellKnown, resource: `${server.origin}/` }];
};

/**
 * Lists the addresses where an authorization server's metadata may be, in the
 * order to try them: RFC 8414 with the issuer's path after the well-known
 * name, then OpenID Connect discovery in its two spellings (the same
 * insertion, and the path before the well-known name).
 */
const buildAuthorizationServerMetadataUrls = (issuer: URL): ReadonlyArray<string> => {
  const path = issuer.pathname.replace(/\/$/, "");
  if (path === "") {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
};

/**
 * Parses an address that an OAuth server named, and checks the outbound rules
 * on it. Fails with `AuthorizationUnreadable` when it is not an address, is not
 * http or https, holds a user name or a password, or is http while it is not on
 * the same host and port as an http MCP server. `what` names the address in the
 * message, which never quotes the address.
 */
const checkOutboundUrl = (
  raw: string,
  server: URL,
  what: string,
): Effect.Effect<URL, AuthorizationUnreadable> => {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return failUnreadable(`the ${what} is not an http or https address`);
  }
  if (url.username !== "" || url.password !== "") {
    return failUnreadable(`the ${what} holds a user name or a password`);
  }
  if (url.protocol === "http:" && !(server.protocol === "http:" && url.host === server.host)) {
    return failUnreadable(`the ${what} is http, and only the MCP server's own origin may be`);
  }
  return Effect.succeed(url);
};

/** Protected resource metadata (RFC 9728): the fields discovery reads. */
const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.Unknown),
  scopes_supported: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const decodeProtectedResourceMetadata = Schema.decodeUnknownOption(ProtectedResourceMetadata);

/**
 * Checks that a resource identifier is exactly the expected one (RFC 9728
 * section 3.3). Both are compared as addresses the way the URL standard
 * writes them, so `https://a.example` is `https://a.example/`. A query or a
 * fragment that one has and the other lacks makes them different.
 */
const isSameResource = (resource: string, expected: string): boolean => {
  const parsed = URL.parse(resource);
  return parsed !== null && parsed.href === new URL(expected).href;
};

/**
 * Checks a scope that a server named. Returns it when it is a list of scope
 * tokens (RFC 6749 section 3.3) of at most 1024 characters, and fails with
 * `AuthorizationUnreadable` otherwise.
 */
const checkScope = (scope: string): Effect.Effect<string, AuthorizationUnreadable> =>
  scope.length <= MAX_SCOPE_LENGTH && SCOPE_PATTERN.test(scope)
    ? Effect.succeed(scope)
    : failUnreadable("the scope the server asks for is not a list of scope names");

/**
 * Validates protected resource metadata and returns what discovery needs of
 * it: the resource identifier, the first authorization server's issuer, and
 * the scopes the metadata lists. Fails with `AuthorizationUnreadable` when
 * the body is not metadata, when its `resource` is not exactly
 * `expectedResource` (RFC 9728 section 3.3: the document may be about another
 * resource, and then it must not be used), or when it names no authorization
 * server. A later authorization server is never used.
 */
const readProtectedResourceMetadata = (
  body: unknown,
  expectedResource: string,
): Effect.Effect<
  {
    readonly resource: string;
    readonly issuer: string;
    readonly scopesSupported: ReadonlyArray<string>;
  },
  AuthorizationUnreadable
> =>
  Effect.gen(function* () {
    const decoded = decodeProtectedResourceMetadata(body);
    if (Option.isNone(decoded)) {
      return yield* failUnreadable("the protected resource metadata is not valid");
    }
    const { resource, authorization_servers, scopes_supported } = decoded.value;
    if (!isSameResource(resource, expectedResource)) {
      return yield* failUnreadable("the protected resource metadata is for another address");
    }
    const issuer = authorization_servers[0];
    if (typeof issuer !== "string") {
      return yield* failUnreadable("the protected resource metadata names no authorization server");
    }
    return {
      resource,
      issuer,
      scopesSupported: (scopes_supported ?? []).filter(
        (scope): scope is string => typeof scope === "string",
      ),
    };
  });

/** Authorization server metadata (RFC 8414): the fields discovery reads. */
const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.NullOr(Schema.String)),
  code_challenge_methods_supported: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  token_endpoint_auth_methods_supported: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Unknown)),
  ),
  authorization_response_iss_parameter_supported: Schema.optional(Schema.Unknown),
});

const decodeAuthorizationServerMetadata = Schema.decodeUnknownOption(AuthorizationServerMetadata);

/**
 * Validates authorization server metadata and returns what the sign-in needs.
 * Fails with:
 *
 * - `AuthorizationUnreadable` when the body is not metadata, when its `issuer`
 *   is not `expectedIssuer` (RFC 8414 section 3.3: otherwise a server could
 *   serve the metadata of another server), when the issuer has a query or a
 *   fragment, when an address in it breaks the outbound rules, or when an
 *   endpoint is http while the issuer is https;
 * - `AuthorizationUnsupported` when it does not list `S256` among its PKCE
 *   methods, because Hercule never signs in without PKCE.
 */
const readAuthorizationServerMetadata = (
  body: unknown,
  expectedIssuer: string,
  server: URL,
): Effect.Effect<AuthorizationServer, AuthorizationUnreadable | AuthorizationUnsupported> =>
  Effect.gen(function* () {
    const decoded = decodeAuthorizationServerMetadata(body);
    if (Option.isNone(decoded) || decoded.value.issuer !== expectedIssuer) {
      return yield* failUnreadable(
        "the authorization server metadata is not valid, or is for another issuer",
      );
    }
    const metadata = decoded.value;
    const issuer = yield* checkOutboundUrl(metadata.issuer, server, "authorization server");
    if (issuer.search !== "" || issuer.hash !== "") {
      return yield* failUnreadable("the authorization server's issuer holds a query or a fragment");
    }
    // An https issuer never sends the client to a plaintext endpoint: the
    // same-host exception for http is for an http issuer (a server run on the
    // user's own machine), and does not let a secure issuer downgrade.
    const checkEndpoint = (raw: string, what: string) =>
      Effect.flatMap(checkOutboundUrl(raw, server, what), (url) =>
        issuer.protocol === "https:" && url.protocol === "http:"
          ? failUnreadable(`the ${what} is http, but its authorization server is https`)
          : Effect.succeed(url),
      );
    const authorizationEndpoint = yield* checkEndpoint(
      metadata.authorization_endpoint,
      "authorization endpoint",
    );
    const tokenEndpoint = yield* checkEndpoint(metadata.token_endpoint, "token endpoint");
    const registrationEndpoint =
      metadata.registration_endpoint == null
        ? undefined
        : yield* checkEndpoint(metadata.registration_endpoint, "registration endpoint");
    if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
      return yield* failUnsupported(
        "its authorization server does not offer PKCE with S256, which Hercule requires",
      );
    }
    return {
      issuer: metadata.issuer,
      authorizationEndpoint: authorizationEndpoint.href,
      tokenEndpoint: tokenEndpoint.href,
      registrationEndpoint: registrationEndpoint?.href,
      sendsIssuer: metadata.authorization_response_iss_parameter_supported === true,
      tokenEndpointAuthMethods: (metadata.token_endpoint_auth_methods_supported ?? []).filter(
        (method): method is string => typeof method === "string",
      ),
    };
  });

/** The answer to a client registration (RFC 7591 section 3.2.1): the fields registration reads. */
const RegistrationAnswer = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.NullOr(Schema.String)),
  token_endpoint_auth_method: Schema.optional(Schema.NullOr(Schema.String)),
  redirect_uris: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  client_secret_expires_at: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeRegistrationAnswer = Schema.decodeUnknownOption(RegistrationAnswer);

/**
 * Validates the answer to a client registration and returns the client.
 * Fails with `AuthorizationUnreadable` when the answer is not a registration,
 * when it lists redirect addresses that do not include the registered one
 * (a sign-in would then be refused at the browser), when it gives a client
 * authentication method Hercule does not speak, or when it gives a method that
 * needs a secret and no secret. A secret's `client_secret_expires_at` is kept
 * as `secretExpiresAtMillis`, unless it is 0 or more than ten years away,
 * which both mean the secret never expires.
 *
 * A client that got a secret signs its token requests with the method the
 * answer names. When the answer names none, the method is
 * `client_secret_post` if the token endpoint lists it and `client_secret_basic`
 * otherwise (RFC 7591 section 2 makes basic the default). A client with no
 * secret, or with the method `none`, is public.
 */
const readRegisteredClient = (
  body: unknown,
  tokenEndpointAuthMethods: ReadonlyArray<string>,
): Effect.Effect<RegisteredClient, AuthorizationUnreadable> =>
  Effect.gen(function* () {
    const decoded = decodeRegistrationAnswer(body);
    if (Option.isNone(decoded)) {
      return yield* failUnreadable("the client registration answer is not valid");
    }
    const answer = decoded.value;
    // A field that is null counts as absent.
    const redirectUris = answer.redirect_uris ?? undefined;
    if (redirectUris !== undefined && !redirectUris.includes(REGISTERED_REDIRECT_URI)) {
      return yield* failUnreadable(
        "the client registration answer does not keep the redirect address that was registered",
      );
    }
    const clientId = answer.client_id;
    const clientSecret = answer.client_secret ?? undefined;
    const answered = answer.token_endpoint_auth_method ?? undefined;
    if (answered === "none" || (answered === undefined && clientSecret === undefined)) {
      return { clientId, authMethod: "none" };
    }
    const authMethod =
      answered ??
      (tokenEndpointAuthMethods.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic");
    if (authMethod !== "client_secret_post" && authMethod !== "client_secret_basic") {
      return yield* failUnreadable(
        "the client registration answer uses an unsupported client authentication method",
      );
    }
    if (clientSecret === undefined || clientSecret === "") {
      return yield* failUnreadable("the client registration answer has no client secret");
    }
    // The time is in seconds since the epoch, and 0 means it never expires.
    // A time more than ten years away is read as never expiring too: a huge
    // one would become infinite in milliseconds, which JSON stores as `null`
    // and the stored sign-in then fails to read.
    const expiresAtMillis = (answer.client_secret_expires_at ?? 0) * 1000;
    const nowMillis = yield* Clock.currentTimeMillis;
    return {
      clientId,
      clientSecret,
      authMethod,
      ...(expiresAtMillis > 0 && expiresAtMillis <= nowMillis + MAX_SECRET_LIFETIME_MILLIS
        ? { secretExpiresAtMillis: expiresAtMillis }
        : {}),
    };
  });

/**
 * Builds the address that the user opens to sign in (RFC 6749 section 4.1.1
 * with PKCE and RFC 8707). Parameters the endpoint already has in its query
 * stay, except the ones this sets.
 */
export const buildAuthorizationUrl = (request: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly resource: string;
  readonly scope: string | undefined;
}): string => {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", request.state);
  url.searchParams.set("resource", request.resource);
  if (request.scope !== undefined) url.searchParams.set("scope", request.scope);
  return url.href;
};

/** What a request got: the status, the `WWW-Authenticate` header, and the body when it was read. */
interface Answer {
  readonly status: number;
  readonly wwwAuthenticate: string | undefined;
  readonly body: string;
}

/**
 * Sends one request under the outbound rules and returns the answer. With
 * `readsBody` false the body is dropped unread, for an answer only its status
 * and headers matter. A redirect, an answer over 1 MiB, a transport failure
 * and a request that takes over 30 seconds fail with `AuthorizationUnreadable`.
 * `what` names the request in the message.
 *
 * The request lives in a scope that ends with this call. Closing the scope
 * aborts the request, which cancels a body that was not read to its end, so a
 * redirect, an error status, a refused size or a dropped probe body never
 * leaves a connection open.
 */
const send = (
  request: HttpClientRequest.HttpClientRequest,
  what: string,
  readsBody: boolean,
): Effect.Effect<Answer, AuthorizationUnreadable, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.transform((execute) =>
          execute.pipe(
            // A redirect would send the request to an address the server picked.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            // No span at all: a client span records the address, and a failed
            // one records the error text.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          ),
        ),
        HttpClient.withScope,
      );
      const response: HttpClientResponse.HttpClientResponse = yield* client.execute(request);
      const { status } = response;
      const wwwAuthenticate = response.headers["www-authenticate"];
      if (status >= 300 && status < 400) {
        return yield* failUnreadable(`the ${what} answered with a redirect, which is not followed`);
      }
      if (!readsBody) return { status, wwwAuthenticate, body: "" };
      const body = yield* readBoundedText(response, what, MAX_METADATA_BYTES);
      return { status, wwwAuthenticate, body };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(REQUEST_TIMEOUT_SECONDS),
      orElse: () =>
        failUnreadable(
          `the ${what} did not answer within ${String(REQUEST_TIMEOUT_SECONDS)} seconds`,
        ),
    }),
    Effect.catchTag("HttpClientError", () => failUnreadable(`the ${what} could not be reached`)),
    Effect.catchTag("ProviderUnreachable", (error) => failUnreadable(error.message)),
  );

/** Parses a body as a JSON object, or returns `undefined` when it is anything else. */
const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads one metadata document. Returns the JSON object when the address
 * answers 200 with one, and `none` when it answers anything else that is not
 * a server failure, such as an unknown address. Fails with
 * `AuthorizationUnreadable` for a redirect, a 5xx, a 429, an answer over 1 MiB
 * and a transport failure, because those say nothing about whether the
 * document exists, and for a 200 answer that is not a JSON object, because
 * the document exists and is broken.
 */
const readMetadata = (
  url: URL,
  what: string,
): Effect.Effect<
  Option.Option<Record<string, unknown>>,
  AuthorizationUnreadable,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const answer = yield* send(HttpClientRequest.get(url, { acceptJson: true }), what, true);
    if (answer.status >= 500 || answer.status === 429) {
      return yield* failUnreadable(`the ${what} answered HTTP ${String(answer.status)}`);
    }
    if (answer.status !== 200) return Option.none();
    const document = parseJsonObject(answer.body);
    return document === undefined
      ? yield* failUnreadable(`the ${what} is not a JSON object`)
      : Option.some(document);
  });

/**
 * Reads the first of the candidates whose address answers with metadata, and
 * returns the document with the candidate that gave it, or `none` when no
 * address does.
 */
const readFirstMetadata = <Candidate extends { readonly url: string }>(
  candidates: ReadonlyArray<Candidate>,
  what: string,
): Effect.Effect<
  Option.Option<{ readonly document: Record<string, unknown>; readonly candidate: Candidate }>,
  AuthorizationUnreadable,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const found = yield* readMetadata(new URL(candidate.url), what);
      if (Option.isSome(found)) return Option.some({ document: found.value, candidate });
    }
    return Option.none();
  });

/**
 * Sends the request that starts an MCP exchange with no credentials, and
 * returns the `Bearer` challenge of its answer. A server that needs a sign-in
 * answers HTTP 401 and says where its OAuth metadata is. Any other answer has
 * no challenge. Fails with `AuthorizationUnreadable` as `send` does, and for a
 * 5xx or a 429.
 */
const probeServer = (
  server: URL,
): Effect.Effect<BearerChallenge, AuthorizationUnreadable, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(server, {
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROBE_PROTOCOL_VERSION,
      },
      body: HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROBE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "hercule", version: "0" },
        },
      }),
    });
    const answer = yield* send(request, "MCP server", false);
    if (answer.status >= 500 || answer.status === 429) {
      return yield* failUnreadable(`the MCP server answered HTTP ${String(answer.status)}`);
    }
    return answer.status === 401
      ? parseBearerChallenge(answer.wwwAuthenticate)
      : { resourceMetadata: undefined, scope: undefined };
  });

/**
 * Finds how a server added by URL signs a user in, from the server's address
 * (RFC 9728 and RFC 8414), and returns its authorization server's metadata with
 * the resource and the scope to ask for.
 *
 * 1. It asks the server to start an MCP exchange with no credentials. The
 *    `Bearer` challenge of an HTTP 401 may name the protected resource
 *    metadata and a scope.
 * 2. It reads the protected resource metadata: the address the challenge
 *    names, or else the well-known address with the server's path, or else the
 *    well-known address of its origin.
 * 3. It reads the metadata of the first authorization server that the
 *    resource metadata lists, trying the RFC 8414 address and then both
 *    OpenID Connect addresses.
 *
 * The scope is the challenge's, else the resource metadata's `scopes_supported`
 * joined by spaces, else none. Fails with:
 *
 * - `AuthorizationUnsupported` when the server publishes no protected
 *   resource metadata at all, or its authorization server does not offer PKCE
 *   with S256;
 * - `AuthorizationUnreadable` for everything else that goes wrong, by the
 *   rules at the top of this file.
 */
export const discoverAuthorization = (
  serverUrl: string,
): Effect.Effect<
  DiscoveredAuthorization,
  AuthorizationUnsupported | AuthorizationUnreadable,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const server = new URL(serverUrl);
    const challenge = yield* probeServer(server);

    // A challenge that names its metadata is the one place to look: a server
    // that names an address that answers nothing breaks the rules.
    const named =
      challenge.resourceMetadata === undefined
        ? undefined
        : yield* checkOutboundUrl(
            challenge.resourceMetadata,
            server,
            "protected resource metadata address",
          );
    // The metadata a challenge names must be about the address that was probed
    // (RFC 9728 section 3.3), and the metadata at a well-known address about
    // the identifier that address was built from.
    const resourceMetadata = yield* readFirstMetadata(
      named === undefined
        ? buildResourceMetadataCandidates(server)
        : [{ url: named.href, resource: withoutFragment(server) }],
      "protected resource metadata",
    );
    if (Option.isNone(resourceMetadata)) {
      return yield* named === undefined
        ? failUnsupported("it publishes no OAuth metadata")
        : failUnreadable("the protected resource metadata that the server names is not there");
    }
    const resource = yield* readProtectedResourceMetadata(
      resourceMetadata.value.document,
      resourceMetadata.value.candidate.resource,
    );

    const issuer = yield* checkOutboundUrl(resource.issuer, server, "authorization server");
    const serverMetadata = yield* readFirstMetadata(
      buildAuthorizationServerMetadataUrls(issuer).map((url) => ({ url })),
      "authorization server metadata",
    );
    if (Option.isNone(serverMetadata)) {
      return yield* failUnreadable("the authorization server's metadata is not there");
    }
    const authorizationServer = yield* readAuthorizationServerMetadata(
      serverMetadata.value.document,
      resource.issuer,
      server,
    );

    const askedScope =
      challenge.scope ??
      (resource.scopesSupported.length > 0 ? resource.scopesSupported.join(" ") : undefined);
    return {
      ...authorizationServer,
      resource: resource.resource,
      scope: askedScope === undefined ? undefined : yield* checkScope(askedScope),
    };
  });

/**
 * Registers Hercule as a client of the authorization server with Dynamic
 * Client Registration (RFC 7591) and returns the client. Hercule is a native
 * application and a public client: it registers the loopback redirect address
 * without a port, asks for the authorization code and refresh token grants, and
 * asks for no client secret. The answer is checked by `readRegisteredClient`.
 *
 * Fails with `AuthorizationUnsupported` when the authorization server offers
 * no registration endpoint, or refuses to register Hercule (an HTTP 4xx), and
 * with `AuthorizationUnreadable` for everything else that goes wrong.
 */
export const registerClient = (
  authorization: AuthorizationServer,
): Effect.Effect<
  RegisteredClient,
  AuthorizationUnsupported | AuthorizationUnreadable,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (authorization.registrationEndpoint === undefined) {
      return yield* failUnsupported(
        "its authorization server offers no client registration, which Hercule needs",
      );
    }
    // The endpoint was checked against the outbound rules when the metadata
    // that names it was read.
    const answer = yield* send(
      HttpClientRequest.post(authorization.registrationEndpoint, {
        acceptJson: true,
        body: HttpBody.jsonUnsafe({
          client_name: "Hercule",
          redirect_uris: [REGISTERED_REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        }),
      }),
      "client registration",
      true,
    );
    if (answer.status >= 500 || answer.status === 429) {
      return yield* failUnreadable(
        `the client registration answered HTTP ${String(answer.status)}`,
      );
    }
    if (answer.status !== 200 && answer.status !== 201) {
      return yield* failUnsupported("its authorization server refused to register Hercule");
    }
    return yield* readRegisteredClient(
      parseJsonObject(answer.body),
      authorization.tokenEndpointAuthMethods,
    );
  });
