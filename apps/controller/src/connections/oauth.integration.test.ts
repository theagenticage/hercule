/**
 * Tests the core's OAuth2 authorization-code client end to end:
 *
 * - the start, which builds an authorization URL;
 * - the callback, which the browser reaches without a credential;
 * - the refresh that a plugin's `credentials()` call triggers.
 *
 * The provider is an in-test `Bun.serve` rather than a stub inside the
 * controller: these tests are about what the controller sends to a token
 * endpoint, so the token endpoint is a real server that records each request.
 *
 * The registry holds test plugins, as in the connection route tests, because a
 * connection type comes from a plugin. Here the plugins also hold the two
 * things an OAuth client needs: a plugin config field `clientId` and a
 * plugin-owned secret `clientSecret`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type ActivationContext,
  type Plugin,
} from "@hercule/plugin-host";
import {
  completeSetup,
  get,
  post,
  send,
  withServer,
  type ServerHarness,
  type ServerOptions,
} from "../http/testing";
import {
  awaitHeldWork,
  freezeController,
  requestTransfer,
  QUIET_LOOP_TIMINGS,
} from "../promotion/testing";
import {
  buildAccount,
  buildAccountName,
  buildJsonResponse,
  listConnections,
  readConnectionsSurface,
  type ConnectionRecord,
  type TestPlugin,
} from "./testing";

/** The error envelope every failing operation returns. */
interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: {
      readonly issues?: ReadonlyArray<{ path: ReadonlyArray<string>; message: string }>;
    };
  };
}

/** The client credentials the tests give the plugin. */
const CLIENT_ID = "client-1";
const CLIENT_SECRET = "shh-1";

/** Access tokens the provider issues: the type accepts the `good-` ones and rejects the other. */
const FIRST_TOKEN = "good-first";
const REFRESHED_TOKEN = "good-refreshed";
const UNUSABLE_TOKEN = "nope-1";

/** The message the OAuth type's `validate` fails with when it rejects an access token. */
const REJECTED = "that account is not one this type can act as";

/** A well-formed `state` that no start ever created. */
const ABSENT_STATE = "zzzz".repeat(16);

/**
 * The token endpoint's response for each grant type, which a test can replace.
 * A test that needs a request held in flight returns a promise it resolves
 * later.
 */
type Answers = Record<string, () => Response | Promise<Response>>;

interface AuthServer {
  /** The origin the type's `authorizationUrl` and `tokenUrl` are built from. */
  readonly base: string;
  /** Every form body posted to the token endpoint, in order. */
  readonly requests: ReadonlyArray<Record<string, string>>;
  /** The token endpoint's next response, keyed by `grant_type`. */
  readonly answers: Answers;
  readonly stop: () => Promise<void>;
}

/**
 * Starts a provider's token endpoint. By default it returns a standard token
 * response, and it records every request so the callback and refresh tests can
 * assert on them.
 */
const createAuthServer = (): AuthServer => {
  const requests: Array<Record<string, string>> = [];
  const answers: Answers = {
    authorization_code: () =>
      buildJsonResponse({
        access_token: FIRST_TOKEN,
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600,
      }),
    refresh_token: () =>
      buildJsonResponse({
        access_token: REFRESHED_TOKEN,
        refresh_token: "refresh-2",
        token_type: "bearer",
        expires_in: 3600,
      }),
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/token") return new Response("not here", { status: 404 });
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      requests.push(form);
      const answer = answers[form["grant_type"] ?? ""];
      return answer === undefined
        ? buildJsonResponse({ error: "unsupported_grant_type" }, 400)
        : answer();
    },
  });

  let stopped = false;
  return {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    answers,
    // A test may stop the provider to simulate an unreachable one, and the
    // harness stops it again afterwards, so a second call does nothing.
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
};

/**
 * Builds a plugin that owns one connection type. An OAuth type points at the
 * in-test provider and validates the access token it receives. A credentials
 * type exists only so a test can start an OAuth flow for a type that has none.
 */
const buildConnectionTypePlugin = (options: {
  readonly id: string;
  readonly type: string;
  readonly oauth?: AuthServer;
}): TestPlugin => {
  const contexts: Array<ActivationContext> = [];
  const provider = options.oauth;

  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: HOST_API,
      capabilities: ["connections"],
      // The client id is a plugin config field, so the type's plugin must be
      // configurable with one.
      configSchema: Schema.Struct({ clientId: Schema.optionalKey(Schema.String) }),
    },
    register: (host) =>
      registerConnectionType(host, {
        type: options.type,
        displayName: `Type ${options.type}`,
        setup:
          provider === undefined
            ? [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }]
            : [{ kind: "oauth" }],
        ...(provider === undefined
          ? {}
          : {
              oauth: {
                authorizationUrl: `${provider.base}/authorize`,
                tokenUrl: `${provider.base}/token`,
                scopes: ["read", "write"],
                extraParams: { access_type: "offline", prompt: "consent" },
              },
            }),
        validate: (credentials: Record<string, string>) => {
          const value = credentials[provider === undefined ? "token" : "accessToken"] ?? "";
          return value.startsWith("good-")
            ? Effect.succeed(buildAccount(value))
            : Effect.fail(new ConnectionValidationFailed({ message: REJECTED }));
        },
      }),
    activate: (ctx) =>
      Effect.sync(() => {
        contexts.push(ctx);
        return Effect.void;
      }),
  };

  return { plugin, contexts };
};

/** Builds new plugins for each test, so no activation context outlives its test. */
const buildPlugins = (provider: AuthServer) => ({
  oauth: buildConnectionTypePlugin({ id: "oauthy", type: "oauth-type", oauth: provider }),
  second: buildConnectionTypePlugin({ id: "second", type: "second-type", oauth: provider }),
  pasted: buildConnectionTypePlugin({ id: "pasted", type: "pasted-type" }),
});

type Registry = ReturnType<typeof buildPlugins>;

/**
 * Runs `body` against a set-up controller that loads the test plugins, with
 * an OAuth provider beside it, and stops the provider afterwards. `timings`
 * are passed to the controller.
 */
const withOAuth = async (
  body: (
    harness: ServerHarness,
    registry: Registry,
    token: string,
    provider: AuthServer,
  ) => Promise<void>,
  timings: Pick<
    ServerOptions,
    "eventRoutingInterval" | "schedulerInterval" | "ingestReconcileInterval"
  > = {},
): Promise<void> => {
  const provider = createAuthServer();
  const registry = buildPlugins(provider);
  try {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        await body(harness, registry, token, provider);
      },
      { ...timings, plugins: Object.values(registry).map((one) => one.plugin) },
    );
  } finally {
    await provider.stop();
  }
};

/** The browser's origin, which the redirect URI is built from. */
const ORIGIN = "http://h.test:4000";
const REDIRECT_URI = `${ORIGIN}/oauth/callback`;

const setClientId = async (base: string, token: string, pluginId: string): Promise<void> => {
  const response = await send("PUT", base, `/api/v1/plugins/${pluginId}/config`, {
    body: { config: { clientId: CLIENT_ID } },
    token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

const setClientSecret = async (base: string, token: string, pluginId: string): Promise<void> => {
  const response = await send("PUT", base, `/api/v1/secrets/plugin/${pluginId}/clientSecret`, {
    body: { value: CLIENT_SECRET },
    token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

const startOAuth = (
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  post(base, "/api/v1/oauth/start", { type: "oauthy/oauth-type", origin: ORIGIN, ...body }, token);

/** Starts an OAuth flow and returns the authorization URL from the response. */
const startOAuthOrFail = async (
  base: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<URL> => {
  const response = await startOAuth(base, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  return new URL(authorizationUrl);
};

/** Calls the callback as the browser does: at the server root, with no bearer token. */
const sendOAuthCallback = (base: string, query: Record<string, string>): Promise<Response> =>
  fetch(`${base}/oauth/callback?${new URLSearchParams(query).toString()}`, {
    redirect: "manual",
    headers: { connection: "close" },
  });

const readError = async (response: Response): Promise<ErrorBody["error"]> =>
  ((await response.json()) as ErrorBody).error;

/** Computes the S256 challenge, as the provider does to check the verifier. */
const computeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** Runs a whole OAuth flow and returns the connection it created. */
const connect = async (base: string, token: string): Promise<ConnectionRecord> => {
  await setClientId(base, token, "oauthy");
  await setClientSecret(base, token, "oauthy");
  const url = await startOAuthOrFail(base, token);
  const response = await sendOAuthCallback(base, {
    state: url.searchParams.get("state") ?? "",
    code: "the-code",
  });
  expect(response.status, response.headers.get("location") ?? "").toBe(302);
  expect(response.headers.get("location")).toBe("/connections?oauth=ok");
  const [one] = await listConnections(base, token);
  if (one === undefined) throw new Error("the callback created no connection");
  return one;
};

describe("POST /oauth/start", () => {
  it("returns an authorization URL with every parameter the provider requires", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");

      const url = await startOAuthOrFail(base, token);

      expect(`${url.origin}${url.pathname}`).toBe(`${provider.base}/authorize`);
      const query = url.searchParams;
      expect(query.get("response_type")).toBe("code");
      expect(query.get("client_id")).toBe(CLIENT_ID);
      expect(query.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(query.get("scope")).toBe("read write");
      expect(query.get("code_challenge_method")).toBe("S256");
      expect(query.get("code_challenge") ?? "").not.toBe("");
      expect(query.get("access_type")).toBe("offline");
      expect(query.get("prompt")).toBe("consent");
      expect((query.get("state") ?? "").length).toBeGreaterThanOrEqual(32);
      // The client secret is never sent to the browser.
      expect(url.toString()).not.toContain(CLIENT_SECRET);
    });
  });

  it("creates a new random state and challenge for every start", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");

      const first = await startOAuthOrFail(base, token);
      const second = await startOAuthOrFail(base, token);

      expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
      expect(first.searchParams.get("code_challenge")).not.toBe(
        second.searchParams.get("code_challenge"),
      );
    });
  });

  it("fails to start when the plugin has no client id, and names the plugin", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientSecret(base, token, "oauthy");

      const response = await startOAuth(base, token, {});

      expect(response.status).toBe(409);
      const error = await readError(response);
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("oauthy");
    });
  });

  it("fails to start when the plugin has no client secret, and names the plugin", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "second");

      const response = await startOAuth(base, token, { type: "second/second-type" });

      expect(response.status).toBe(409);
      const error = await readError(response);
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("second");
    });
  });

  it("rejects a reconnect of a connection that has another type", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      const before = await connect(base, token);
      await setClientId(base, token, "second");
      await setClientSecret(base, token, "second");

      const response = await startOAuth(base, token, {
        type: "second/second-type",
        connectionId: before.id,
      });

      expect(response.status).toBe(400);
      expect(await readError(response)).toMatchObject({ code: "validation" });
    });
  });

  it("refuses a reconnect given a label, topics or config, and stores no flow", async () => {
    await withOAuth(async ({ base, sql }, _registry, token) => {
      const before = await connect(base, token);

      const response = await startOAuth(base, token, {
        connectionId: before.id,
        label: "renamed",
        labels: ["Inbox"],
        config: {},
      });

      expect(response.status).toBe(400);
      const error = await readError(response);
      expect(error.code).toBe("validation");
      expect(error.message).toBe(
        "a reconnect keeps the connection's label, topics and config, so it takes none of " +
          "them: change them with connection.update instead",
      );
      expect(error.details?.issues).toEqual([
        { path: ["label"], message: "a reconnect keeps the connection's label" },
        { path: ["labels"], message: "a reconnect keeps the connection's topics" },
        { path: ["config"], message: "a reconnect keeps the connection's config" },
      ]);
      const rows = await Effect.runPromise(Effect.orDie(sql`SELECT state FROM oauth_setups`));
      expect(rows).toEqual([]);
    });
  });

  it("rejects a type whose setup takes pasted credentials", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "pasted");
      await setClientSecret(base, token, "pasted");

      const response = await startOAuth(base, token, { type: "pasted/pasted-type" });

      expect(await readError(response)).toMatchObject({ code: "validation" });
    });
  });
});

describe("GET /oauth/callback", () => {
  it("exchanges the code with a standard token request and creates the connection the start described", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await startOAuthOrFail(base, token, { label: "work", labels: ["Code"] });

      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "the-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=ok");

      const [exchange] = provider.requests;
      expect(exchange).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      // The verifier proves where the challenge came from: hashing it as the
      // provider does must give the challenge sent in the authorization URL.
      expect(computeChallenge(exchange?.["code_verifier"] ?? "")).toBe(
        url.searchParams.get("code_challenge"),
      );

      const listed = await listConnections(base, token);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        type: "oauthy/oauth-type",
        label: "work",
        labels: ["Code"],
        displayName: buildAccountName(FIRST_TOKEN),
        status: "connected",
        credentials: [{ name: "oauth.tokens" }],
      });
      const text = await (await get(base, "/api/v1/connections", token)).text();
      expect(text).not.toContain(FIRST_TOKEN);
      expect(text).not.toContain("refresh-1");
    });
  });

  it("names a connection the start gave no label after its account, and gives it no topic", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      const one = await connect(base, token);

      expect(one).toMatchObject({
        label: buildAccountName(FIRST_TOKEN),
        displayName: buildAccountName(FIRST_TOKEN),
        labels: [],
        config: {},
      });
    });
  });

  it("creates nothing when the user denies access at the provider", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await startOAuthOrFail(base, token);

      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        error: "access_denied",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=denied");
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("writes nothing when the connection it was reconnecting is gone", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      const before = await connect(base, token);
      const url = await startOAuthOrFail(base, token, { connectionId: before.id });
      expect(
        (await send("DELETE", base, `/api/v1/connections/${before.id}`, { token })).status,
      ).toBe(200);

      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=expired");
      expect(await listConnections(base, token)).toEqual([]);
      const secrets = await get(
        base,
        `/api/v1/secrets?ownerKind=connection&ownerId=${before.id}`,
        token,
      );
      expect(await secrets.json()).toEqual({ items: [] });
    });
  });

  it("accepts a state only once, and creates nothing the second time it is presented", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await startOAuthOrFail(base, token);
      const state = url.searchParams.get("state") ?? "";
      expect((await sendOAuthCallback(base, { state, code: "the-code" })).status).toBe(302);

      const again = await sendOAuthCallback(base, { state, code: "the-code" });

      expect(again.status).toBe(302);
      expect(again.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(again.headers.get("location")).toMatch(/^\/connections\?oauth=/);
      expect(await listConnections(base, token)).toHaveLength(1);
    });
  });

  it("rejects an unknown state and an expired one", async () => {
    await withOAuth(async ({ base, sql }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await startOAuthOrFail(base, token);
      const state = url.searchParams.get("state") ?? "";
      // A test cannot wait out the setup's ten minutes, so it edits the row's
      // expiry directly. This is the only step the test cannot do through the API.
      await Effect.runPromise(
        Effect.orDie(
          sql`UPDATE oauth_setups SET expires_at = '2020-01-01T00:00:00.000Z' WHERE state = ${state}`,
        ),
      );

      const unknown = await sendOAuthCallback(base, { state: ABSENT_STATE, code: "the-code" });
      const expired = await sendOAuthCallback(base, { state, code: "the-code" });

      for (const response of [unknown, expired]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toMatch(/^\/connections\?oauth=/);
        expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      }
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("creates nothing when the token endpoint rejects the code", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      provider.answers["authorization_code"] = () =>
        buildJsonResponse({ error: "invalid_grant" }, 400);
      const url = await startOAuthOrFail(base, token);

      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "the-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/^\/connections\?oauth=/);
      expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("creates nothing when the type rejects the account", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      provider.answers["authorization_code"] = () =>
        buildJsonResponse({ access_token: UNUSABLE_TOKEN, token_type: "bearer", expires_in: 3600 });
      const url = await startOAuthOrFail(base, token);

      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "the-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("reconnects the connection the start named, keeps its id, label and topics, and takes the new name of the same account", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      const before = await connect(base, token);
      const renamed = await send("PATCH", base, `/api/v1/connections/${before.id}`, {
        body: { label: "personal", labels: ["Inbox"] },
        token,
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      await Effect.runPromise(
        readConnectionsSurface(registry.oauth).report(before.id, { status: "needs-reauth" }),
      );
      provider.answers["authorization_code"] = () =>
        buildJsonResponse({
          access_token: "good-second",
          refresh_token: "refresh-9",
          token_type: "bearer",
          expires_in: 3600,
        });

      const url = await startOAuthOrFail(base, token, { connectionId: before.id });
      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=ok");
      const listed = await listConnections(base, token);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: before.id,
        label: "personal",
        labels: ["Inbox"],
        status: "connected",
        displayName: buildAccountName("good-second"),
      });
      expect(
        await Effect.runPromise(readConnectionsSurface(registry.oauth).credentials(before.id)),
      ).toMatchObject({ accessToken: "good-second" });
    });
  });

  it("refuses a reconnect that signs in to another account with the other-account outcome, and leaves the connection unchanged", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      const before = await connect(base, token);
      const surface = readConnectionsSurface(registry.oauth);
      await Effect.runPromise(surface.report(before.id, { status: "needs-reauth" }));
      provider.answers["authorization_code"] = () =>
        // A token the type accepts, for another account than the first sign-in.
        buildJsonResponse({ access_token: "good-other@account-2", token_type: "bearer" });

      const url = await startOAuthOrFail(base, token, { connectionId: before.id });
      const response = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });

      expect(response.headers.get("location")).toBe("/connections?oauth=other-account");
      expect(await listConnections(base, token)).toEqual([
        expect.objectContaining({
          id: before.id,
          status: "needs-reauth",
          displayName: buildAccountName(FIRST_TOKEN),
        }),
      ]);
      expect(await Effect.runPromise(surface.credentials(before.id))).toMatchObject({
        accessToken: FIRST_TOKEN,
      });
    });
  });
});

describe("the access token a plugin asks the core for", () => {
  /**
   * Makes the code exchange return a token that expires in one second. That is
   * well inside the refresh margin, so the token needs a refresh as soon as it
   * is stored.
   */
  const makeTokensExpireNow = (provider: AuthServer): void => {
    provider.answers["authorization_code"] = () =>
      buildJsonResponse({
        access_token: FIRST_TOKEN,
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 1,
      });
  };

  it("is returned without calling the provider while it is still valid", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      const one = await connect(base, token);
      const asked = provider.requests.length;

      const credentials = await Effect.runPromise(
        readConnectionsSurface(registry.oauth).credentials(one.id),
      );

      expect(credentials).toMatchObject({ accessToken: FIRST_TOKEN });
      expect(provider.requests).toHaveLength(asked);
    });
  });

  it("is refreshed when it has expired, and the new one is stored", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      const surface = readConnectionsSurface(registry.oauth);

      const refreshed = await Effect.runPromise(surface.credentials(one.id));

      expect(refreshed).toMatchObject({ accessToken: REFRESHED_TOKEN });
      const refresh = provider.requests.at(-1);
      expect(refresh).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });

      // The new token set was stored, so the next call does not refresh again.
      const asked = provider.requests.length;
      expect(await Effect.runPromise(surface.credentials(one.id))).toMatchObject({
        accessToken: REFRESHED_TOKEN,
      });
      expect(provider.requests).toHaveLength(asked);
    });
  });

  it("is refreshed only once when two callers find the same expired token at the same time", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      const surface = readConnectionsSurface(registry.oauth);

      const both = await Effect.runPromise(
        Effect.all([surface.credentials(one.id), surface.credentials(one.id)], {
          concurrency: "unbounded",
        }),
      );

      // A provider that rotates its refresh token invalidates the old one, so a
      // second refresh with the same token would leave one caller with tokens
      // that no longer work.
      expect(
        provider.requests.filter((form) => form["grant_type"] === "refresh_token"),
      ).toHaveLength(1);
      expect(both[0]).toMatchObject({ accessToken: REFRESHED_TOKEN });
      expect(both[1]).toMatchObject({ accessToken: REFRESHED_TOKEN });
    });
  });

  it("is refreshed only after a promotion's freeze ends, when it expires while the controller is frozen", async () => {
    await withOAuth(async ({ base, promotion }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      const promotionToken = await freezeController(base, token);

      const credentials = Effect.runPromise(
        readConnectionsSurface(registry.oauth).credentials(one.id),
      );
      // A rotated refresh token would be spent on the provider, but the new
      // one could not be stored: the copy on the new machine would keep the
      // spent one. So the refresh waits at the promotion gate, and the
      // provider is not called while the controller is frozen.
      await Effect.runPromise(awaitHeldWork(promotion, 1));
      expect(provider.requests.filter((form) => form["grant_type"] === "refresh_token")).toEqual(
        [],
      );

      const cancelled = await requestTransfer(base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
      expect(await credentials).toMatchObject({ accessToken: REFRESHED_TOKEN });
      expect(
        provider.requests.filter((form) => form["grant_type"] === "refresh_token"),
      ).toHaveLength(1);
    }, QUIET_LOOP_TIMINGS);
  });

  it("fails, and leaves the connection status unchanged, when the provider cannot be reached", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      // Nothing listens on that port any more, which fails the same way as a
      // DNS failure or a dropped network.
      await provider.stop();

      const failure = await Effect.runPromise(
        Effect.flip(readConnectionsSurface(registry.oauth).credentials(one.id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionUnavailable" });
      // The provider never rejected the credential, so there is nothing to reconnect.
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      expect(await response.json()).toMatchObject({ status: "connected" });
    });
  });

  it("fails, and marks the connection needs-reauth, when the provider rejects the refresh", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      provider.answers["refresh_token"] = () => buildJsonResponse({ error: "invalid_grant" }, 400);

      const failure = await Effect.runPromise(
        Effect.flip(readConnectionsSurface(registry.oauth).credentials(one.id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionUnavailable" });
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      expect(await response.json()).toMatchObject({ status: "needs-reauth" });
    });
  });

  it("fails, and marks the connection needs-reauth, when the provider refuses the refresh with HTTP 200", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      // GitHub returns its OAuth errors with status 200. The error field, not
      // the status, decides that the provider refused the refresh, rather than
      // answered with something unreadable.
      provider.answers["refresh_token"] = () => buildJsonResponse({ error: "bad_refresh_token" });

      const failure = await Effect.runPromise(
        Effect.flip(readConnectionsSurface(registry.oauth).credentials(one.id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionUnavailable" });
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      expect(await response.json()).toMatchObject({ status: "needs-reauth" });
    });
  });

  describe("when the user reconnects while a refresh is in flight", () => {
    /**
     * Connects with tokens that need a refresh, starts a `credentials()` call
     * whose refresh the provider holds, and reconnects through a second
     * redirect flow while it waits. The provider then answers the held refresh
     * with `answer`. Returns the held call's outcome and the connection.
     */
    const reconnectDuringRefresh = async (
      { base }: ServerHarness,
      registry: Registry,
      token: string,
      provider: AuthServer,
      answer: () => Response,
    ) => {
      makeTokensExpireNow(provider);
      const one = await connect(base, token);
      const surface = readConnectionsSurface(registry.oauth);
      let releaseRefresh = (): void => {};
      let refreshArrived = (): void => {};
      const arrived = new Promise<void>((resolve) => {
        refreshArrived = resolve;
      });
      provider.answers["refresh_token"] = () => {
        refreshArrived();
        return new Promise((resolve) => {
          releaseRefresh = () => {
            resolve(answer());
          };
        });
      };
      const held = Effect.runPromise(Effect.result(surface.credentials(one.id)));
      await arrived;

      provider.answers["authorization_code"] = () =>
        buildJsonResponse({
          access_token: "good-second",
          refresh_token: "refresh-9",
          token_type: "bearer",
          expires_in: 3600,
        });
      const url = await startOAuthOrFail(base, token, { connectionId: one.id });
      const callback = await sendOAuthCallback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });
      expect(callback.headers.get("location")).toBe("/connections?oauth=ok");

      releaseRefresh();
      const outcome = await held;
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      return { outcome, connection: (await response.json()) as ConnectionRecord, one, surface };
    };

    it("keeps the new tokens instead of the refreshed old ones", async () => {
      await withOAuth(async (harness, registry, token, provider) => {
        const { outcome, connection, one, surface } = await reconnectDuringRefresh(
          harness,
          registry,
          token,
          provider,
          () =>
            buildJsonResponse({
              access_token: REFRESHED_TOKEN,
              refresh_token: "refresh-2",
              token_type: "bearer",
              expires_in: 3600,
            }),
        );

        expect(outcome).toMatchObject({ failure: { _tag: "ConnectionUnavailable" } });
        expect(connection).toMatchObject({ status: "connected" });
        expect(await Effect.runPromise(surface.credentials(one.id))).toMatchObject({
          accessToken: "good-second",
        });
      });
    });

    it("leaves the connection connected when the provider rejects the old refresh", async () => {
      await withOAuth(async (harness, registry, token, provider) => {
        const { outcome, connection, one, surface } = await reconnectDuringRefresh(
          harness,
          registry,
          token,
          provider,
          () => buildJsonResponse({ error: "invalid_grant" }, 400),
        );

        expect(outcome).toMatchObject({ failure: { _tag: "ConnectionUnavailable" } });
        expect(connection).toMatchObject({ status: "connected" });
        expect(await Effect.runPromise(surface.credentials(one.id))).toMatchObject({
          accessToken: "good-second",
        });
      });
    });
  });
});
