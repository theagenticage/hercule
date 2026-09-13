/**
 * The core's OAuth2 authorization-code client, end to end: the start that
 * builds an authorization URL, the callback the browser arrives at with no
 * credential, and the refresh a plugin's `credentials()` triggers.
 *
 * The provider is an in-test `Bun.serve` rather than a stub inside the
 * controller: the whole subject here is what the controller puts on the wire to
 * a token endpoint, so the token endpoint is a real one that records it.
 *
 * The registry is test plugins for the same reason the connection routes use
 * them - a connection type is a plugin contribution - and here they also carry
 * the two things an OAuth client needs: a plugin config field `clientId` and a
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
} from "@hydra/plugin-host";
import { completeSetup, get, post, send, withServer, type ServerHarness } from "../http/testing";

/** A connection as the API hands it back; only the fields these tests read. */
interface ConnectionRecord {
  readonly id: string;
  readonly pluginId: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly labels: ReadonlyArray<string>;
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly rotatedAt?: string }>;
}

/** The error envelope every failing operation answers with. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** The client credentials the plugin owns, as this test arranges them. */
const CLIENT_ID = "client-1";
const CLIENT_SECRET = "shh-1";

/** What the provider hands out, and what the type makes of it. */
const FIRST_TOKEN = "good-first";
const REFRESHED_TOKEN = "good-refreshed";
const UNUSABLE_TOKEN = "nope-1";

/** What the OAuth type says when it turns an access token down. */
const REJECTED = "that account is not one this type can act as";

/** A `state` of the right shape that no start ever minted. */
const ABSENT_STATE = "zzzz".repeat(16);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A token endpoint's answer, per grant type, as a test decides it. */
type Answers = Record<string, () => Response>;

interface AuthServer {
  /** The origin the type's `authorizationUrl` and `tokenUrl` are built from. */
  readonly base: string;
  /** Every form body the token endpoint was posted, in order. */
  readonly requests: ReadonlyArray<Record<string, string>>;
  /** What the token endpoint answers next, keyed by `grant_type`. */
  readonly answers: Answers;
  readonly stop: () => Promise<void>;
}

/**
 * A provider's token endpoint. It answers a standard token response by default
 * and records what it was asked, which is what the callback and refresh tests
 * assert against.
 */
const authServer = (): AuthServer => {
  const requests: Array<Record<string, string>> = [];
  const answers: Answers = {
    authorization_code: () =>
      json({
        access_token: FIRST_TOKEN,
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600,
      }),
    refresh_token: () =>
      json({
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
      return answer === undefined ? json({ error: "unsupported_grant_type" }, 400) : answer();
    },
  });

  let stopped = false;
  return {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    answers,
    // A test may close the provider to see what an unreachable one does, and
    // the harness closes it again afterwards.
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
};

/** A plugin and the activation contexts the host handed it. */
interface TestPlugin {
  readonly plugin: Plugin;
  readonly contexts: Array<ActivationContext>;
}

/**
 * One plugin owning one type. An OAuth type points at the in-test provider and
 * judges the access token it was handed; a credentials type is here only so a
 * start against the wrong kind of setup has something to be refused for.
 */
const typePlugin = (options: {
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
            ? Effect.succeed({ displayName: `acct:${value}` })
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

/** The registry every test boots, built afresh so no context outlives its test. */
const plugins = (provider: AuthServer) => ({
  oauth: typePlugin({ id: "oauthy", type: "oauth-type", oauth: provider }),
  second: typePlugin({ id: "second", type: "second-type", oauth: provider }),
  pasted: typePlugin({ id: "pasted", type: "pasted-type" }),
});

type Registry = ReturnType<typeof plugins>;

const withOAuth = async (
  body: (
    harness: ServerHarness,
    registry: Registry,
    token: string,
    provider: AuthServer,
  ) => Promise<void>,
): Promise<void> => {
  const provider = authServer();
  const registry = plugins(provider);
  try {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        await body(harness, registry, token, provider);
      },
      { plugins: Object.values(registry).map((one) => one.plugin) },
    );
  } finally {
    await provider.stop();
  }
};

/** The origin the browser is at, which is what the redirect URI is built from. */
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

const start = (base: string, token: string, body: Record<string, unknown>): Promise<Response> =>
  post(
    base,
    "/api/v1/oauth/start",
    { type: "oauth-type", origin: ORIGIN, label: "work", labels: ["Code"], ...body },
    token,
  );

/** Starts a setup and hands back the authorization URL it answered with. */
const started = async (
  base: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<URL> => {
  const response = await start(base, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  return new URL(authorizationUrl);
};

/** The callback as the browser reaches it: server root, no bearer, no redirect followed. */
const callback = (base: string, query: Record<string, string>): Promise<Response> =>
  fetch(`${base}/oauth/callback?${new URLSearchParams(query).toString()}`, {
    redirect: "manual",
    headers: { connection: "close" },
  });

const connections = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ConnectionRecord>> => {
  const response = await get(base, "/api/v1/connections", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<ConnectionRecord> }).items;
};

const errorOf = async (response: Response): Promise<ErrorBody["error"]> =>
  ((await response.json()) as ErrorBody).error;

/** The S256 transformation the provider would apply to check the verifier. */
const challengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** The runtime surface the host handed a plugin at its last activation. */
const surfaceOf = (of: TestPlugin) => {
  const ctx = of.contexts.at(-1);
  if (ctx === undefined) throw new Error("the plugin was never activated");
  if (ctx.connections === undefined) throw new Error("the plugin was given no connections surface");
  return ctx.connections;
};

/** Runs one whole setup and hands back the connection it created. */
const connect = async (base: string, token: string): Promise<ConnectionRecord> => {
  await setClientId(base, token, "oauthy");
  await setClientSecret(base, token, "oauthy");
  const url = await started(base, token);
  const response = await callback(base, {
    state: url.searchParams.get("state") ?? "",
    code: "the-code",
  });
  expect(response.status, response.headers.get("location") ?? "").toBe(302);
  expect(response.headers.get("location")).toBe("/connections?oauth=ok");
  const [one] = await connections(base, token);
  if (one === undefined) throw new Error("the callback created no connection");
  return one;
};

describe("POST /oauth/start", () => {
  it("answers an authorization URL carrying everything the provider asks of the client", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");

      const url = await started(base, token);

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
      // The secret half of the client's credentials is never handed to a browser.
      expect(url.toString()).not.toContain(CLIENT_SECRET);
    });
  });

  it("mints a state nobody can guess from the last one", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");

      const first = await started(base, token);
      const second = await started(base, token);

      expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
      expect(first.searchParams.get("code_challenge")).not.toBe(
        second.searchParams.get("code_challenge"),
      );
    });
  });

  it("refuses to start when the plugin has no client id, and names the plugin", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientSecret(base, token, "oauthy");

      const response = await start(base, token, {});

      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("oauthy");
    });
  });

  it("refuses to start when the plugin has no client secret, and names the plugin", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "second");

      const response = await start(base, token, { type: "second-type" });

      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("second");
    });
  });

  it("refuses a reconnect of a connection that is of another type", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      const before = await connect(base, token);
      await setClientId(base, token, "second");
      await setClientSecret(base, token, "second");

      const response = await start(base, token, {
        type: "second-type",
        connectionId: before.id,
      });

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "validation" });
    });
  });

  it("refuses a type whose setup is a pasted credential", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "pasted");
      await setClientSecret(base, token, "pasted");

      const response = await start(base, token, { type: "pasted-type" });

      expect(await errorOf(response)).toMatchObject({ code: "validation" });
    });
  });
});

describe("GET /oauth/callback", () => {
  it("exchanges the code the standard way and creates the connection the setup described", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await started(base, token, { label: "work", labels: ["Code"] });

      const response = await callback(base, {
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
      // The verifier is the proof the challenge was made from: hashing it the
      // way the provider would must land back on what the start published.
      expect(challengeFor(exchange?.["code_verifier"] ?? "")).toBe(
        url.searchParams.get("code_challenge"),
      );

      const listed = await connections(base, token);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        pluginId: "oauthy",
        type: "oauth-type",
        label: "work",
        labels: ["Code"],
        displayName: `acct:${FIRST_TOKEN}`,
        status: "connected",
        credentials: [{ name: "oauth.tokens" }],
      });
      const text = await (await get(base, "/api/v1/connections", token)).text();
      // The display name is derived from the token, so it says the token in the
      // one place it may and under no other key.
      expect(text.split(`acct:${FIRST_TOKEN}`).join("")).not.toContain(FIRST_TOKEN);
      expect(text).not.toContain("refresh-1");
    });
  });

  it("creates nothing when the provider sends the user back refusing", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await started(base, token);

      const response = await callback(base, {
        state: url.searchParams.get("state") ?? "",
        error: "access_denied",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=denied");
      expect(await connections(base, token)).toEqual([]);
    });
  });

  it("writes nothing when the connection it was reconnecting is gone", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      const before = await connect(base, token);
      const url = await started(base, token, { connectionId: before.id });
      expect(
        (await send("DELETE", base, `/api/v1/connections/${before.id}`, { token })).status,
      ).toBe(200);

      const response = await callback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=expired");
      expect(await connections(base, token)).toEqual([]);
      const secrets = await get(
        base,
        `/api/v1/secrets?ownerKind=connection&ownerId=${before.id}`,
        token,
      );
      expect(await secrets.json()).toEqual({ items: [] });
    });
  });

  it("spends a state once, and creates nothing the second time it is presented", async () => {
    await withOAuth(async ({ base }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await started(base, token);
      const state = url.searchParams.get("state") ?? "";
      expect((await callback(base, { state, code: "the-code" })).status).toBe(302);

      const again = await callback(base, { state, code: "the-code" });

      expect(again.status).toBe(302);
      expect(again.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(again.headers.get("location")).toMatch(/^\/connections\?oauth=/);
      expect(await connections(base, token)).toHaveLength(1);
    });
  });

  it("turns a state nobody started away, and one that has run out of time", async () => {
    await withOAuth(async ({ base, sql }, _registry, token) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      const url = await started(base, token);
      const state = url.searchParams.get("state") ?? "";
      // The setup's ten minutes cannot be waited out, so the pending row is
      // aged instead - the only part of this a test cannot arrange from outside.
      await Effect.runPromise(
        Effect.orDie(
          sql`UPDATE oauth_setups SET expires_at = '2020-01-01T00:00:00.000Z' WHERE state = ${state}`,
        ),
      );

      const unknown = await callback(base, { state: ABSENT_STATE, code: "the-code" });
      const expired = await callback(base, { state, code: "the-code" });

      for (const response of [unknown, expired]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toMatch(/^\/connections\?oauth=/);
        expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      }
      expect(await connections(base, token)).toEqual([]);
    });
  });

  it("creates nothing when the token endpoint refuses the code", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      provider.answers["authorization_code"] = () => json({ error: "invalid_grant" }, 400);
      const url = await started(base, token);

      const response = await callback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "the-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/^\/connections\?oauth=/);
      expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(await connections(base, token)).toEqual([]);
    });
  });

  it("creates nothing when the type turns the account down", async () => {
    await withOAuth(async ({ base }, _registry, token, provider) => {
      await setClientId(base, token, "oauthy");
      await setClientSecret(base, token, "oauthy");
      provider.answers["authorization_code"] = () =>
        json({ access_token: UNUSABLE_TOKEN, token_type: "bearer", expires_in: 3600 });
      const url = await started(base, token);

      const response = await callback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "the-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toBe("/connections?oauth=ok");
      expect(await connections(base, token)).toEqual([]);
    });
  });

  it("reconnects the connection the setup named, under its own id", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      const before = await connect(base, token);
      await Effect.runPromise(
        surfaceOf(registry.oauth).report(before.id, { status: "needs-reauth" }),
      );
      provider.answers["authorization_code"] = () =>
        json({
          access_token: "good-second",
          refresh_token: "refresh-9",
          token_type: "bearer",
          expires_in: 3600,
        });

      const url = await started(base, token, { connectionId: before.id });
      const response = await callback(base, {
        state: url.searchParams.get("state") ?? "",
        code: "another-code",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/connections?oauth=ok");
      const listed = await connections(base, token);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: before.id,
        status: "connected",
        displayName: "acct:good-second",
      });
      expect(
        await Effect.runPromise(surfaceOf(registry.oauth).credentials(before.id)),
      ).toMatchObject({ accessToken: "good-second" });
    });
  });
});

describe("the access token a plugin asks the core for", () => {
  /**
   * An exchange whose token is not worth handing over: a second is well inside
   * the margin the core refreshes within, so it is stale the moment it lands.
   */
  const expiringNow = (provider: AuthServer): void => {
    provider.answers["authorization_code"] = () =>
      json({
        access_token: FIRST_TOKEN,
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 1,
      });
  };

  it("is handed over without asking the provider again while it is still good", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      const one = await connect(base, token);
      const asked = provider.requests.length;

      const credentials = await Effect.runPromise(surfaceOf(registry.oauth).credentials(one.id));

      expect(credentials).toMatchObject({ accessToken: FIRST_TOKEN });
      expect(provider.requests).toHaveLength(asked);
    });
  });

  it("is refreshed when it has run out, and the fresh one is kept", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      expiringNow(provider);
      const one = await connect(base, token);
      const surface = surfaceOf(registry.oauth);

      const refreshed = await Effect.runPromise(surface.credentials(one.id));

      expect(refreshed).toMatchObject({ accessToken: REFRESHED_TOKEN });
      const refresh = provider.requests.at(-1);
      expect(refresh).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });

      // The new token set was written down, so the next caller spends nothing.
      const asked = provider.requests.length;
      expect(await Effect.runPromise(surface.credentials(one.id))).toMatchObject({
        accessToken: REFRESHED_TOKEN,
      });
      expect(provider.requests).toHaveLength(asked);
    });
  });

  it("is refreshed once when two callers find the same spent token at the same moment", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      expiringNow(provider);
      const one = await connect(base, token);
      const surface = surfaceOf(registry.oauth);

      const both = await Effect.runPromise(
        Effect.all([surface.credentials(one.id), surface.credentials(one.id)], {
          concurrency: "unbounded",
        }),
      );

      // A provider that rotates its refresh token invalidates the old one, so a
      // second refresh with the same token would leave one caller holding a set
      // that no longer works.
      expect(
        provider.requests.filter((form) => form["grant_type"] === "refresh_token"),
      ).toHaveLength(1);
      expect(both[0]).toMatchObject({ accessToken: REFRESHED_TOKEN });
      expect(both[1]).toMatchObject({ accessToken: REFRESHED_TOKEN });
    });
  });

  it("fails, and leaves the connection alone, when the provider cannot be reached", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      expiringNow(provider);
      const one = await connect(base, token);
      // Nothing is listening on that port any more, which is what a name that
      // does not resolve and a network that drops both come back as.
      await provider.stop();

      const failure = await Effect.runPromise(
        Effect.flip(surfaceOf(registry.oauth).credentials(one.id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionUnavailable" });
      // The credential was never turned down, so there is nothing to reconnect.
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      expect(await response.json()).toMatchObject({ status: "connected" });
    });
  });

  it("fails, and leaves the connection needing reauthentication, when the refresh is refused", async () => {
    await withOAuth(async ({ base }, registry, token, provider) => {
      expiringNow(provider);
      const one = await connect(base, token);
      provider.answers["refresh_token"] = () => json({ error: "invalid_grant" }, 400);

      const failure = await Effect.runPromise(
        Effect.flip(surfaceOf(registry.oauth).credentials(one.id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionUnavailable" });
      const response = await get(base, `/api/v1/connections/${one.id}`, token);
      expect(await response.json()).toMatchObject({ status: "needs-reauth" });
    });
  });
});
