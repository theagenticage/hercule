/**
 * Tests the reads of a GitHub Connection's token, over a real database and an
 * in-test token endpoint:
 *
 * - what the refreshing read returns for a token that is fresh, one inside
 *   the refresh margin, and a pasted token;
 * - each way it refuses, and the one-line reason it gives;
 * - that the plain read gives no token for a Connection the refreshing read
 *   refuses.
 *
 * The clock is a `TestClock` at the epoch, so a token's expiry is set in
 * milliseconds after the epoch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import type * as SqlClient from "effect/sql/SqlClient";
import { GITHUB_CONNECTION_TYPE } from "@hercule/contract";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase, inTransaction } from "../db/testing";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { masterKeyLayer, Secrets, secretsLayer } from "../secrets";
import { OAUTH_TOKENS, serializeTokens, type TokenSet } from "./oauth";
import { PluginConfigs } from "./plugin-configs";
import { connectionRepository } from "./repository";
import { githubTokens } from "./github";
import { ConnectionTypes, ConnectionTypesLayer } from "./runtime";
import { buildJsonResponse, createDeviceProvider, type DeviceProvider } from "./testing";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The name of the account the Connection is for, which the Connections screen shows. */
const LOGIN = "octocat";

let homes: Array<string> = [];
let provider: DeviceProvider | undefined;

afterEach(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
  await provider?.stop();
  provider = undefined;
});

const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-github-token-"));
  homes.push(home);
  return ConnectionTypesLayer.pipe(
    Layer.provideMerge(Layer.succeed(PluginConfigs)({ of: () => Effect.succeed({}) })),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(ServingPromotionStateLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

/** What a test arranges for its Connection. */
interface Arrangement {
  readonly status?: "disabled" | "needs-reauth" | "error";
  /** The pasted token. */
  readonly pat?: string;
  /** The token set a device flow stored. */
  readonly tokens?: TokenSet;
}

/**
 * Registers a GitHub type with a device flow against the test provider, and
 * stores a Connection of that type as the arrangement says. Returns the
 * Connection's id and runs `use` with it.
 */
const run = <A, E>(
  arrangement: Arrangement,
  use: (id: string) => Effect.Effect<A, E, ConnectionTypes | Secrets | SqlClient.SqlClient>,
): Promise<A> => {
  const started = createDeviceProvider();
  provider = started;
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(ConnectionTypes, (types) =>
        types.replace([
          {
            pluginId: "github",
            contribution: {
              type: GITHUB_CONNECTION_TYPE,
              displayName: "GitHub",
              setup: [{ kind: "device" }],
              device: {
                clientId: "device-client-1",
                deviceCodeUrl: `${started.base}/device/code`,
                tokenUrl: `${started.base}/token`,
                scopes: [],
              },
              validate: () => Effect.succeed({ displayName: LOGIN, accountId: "583231" }),
            },
            feeds: {},
          },
        ]),
      );
      const connections = yield* connectionRepository;
      const secrets = yield* Secrets;
      const id = yield* inTransaction(
        Effect.gen(function* () {
          const at = "2026-09-01T00:00:00.000Z";
          const row = yield* connections.insert({
            pluginId: "github",
            type: GITHUB_CONNECTION_TYPE,
            label: "work",
            displayName: LOGIN,
            accountId: "583231",
            labels: [],
            config: {},
            at,
          });
          const owner = { kind: "connection", id: row.id } as const;
          if (arrangement.status !== undefined) {
            yield* connections.update(row.id, { status: arrangement.status }, at);
          }
          if (arrangement.pat !== undefined) {
            yield* secrets.set(owner, "pat", Redacted.make(arrangement.pat));
          }
          if (arrangement.tokens !== undefined) {
            yield* secrets.set(
              owner,
              OAUTH_TOKENS,
              Redacted.make(serializeTokens(arrangement.tokens)),
            );
          }
          return row.id;
        }),
      );
      return yield* use(id);
    }).pipe(Effect.provide(buildStack()), Effect.provide(TestClock.layer())),
  );
};

const readToken = (id: string) =>
  Effect.flatMap(githubTokens, (tokens) => tokens.readFreshGithubToken(id));

const findToken = (id: string) =>
  Effect.flatMap(githubTokens, (tokens) => tokens.findGithubToken(id));

const readStatus = (id: string) =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const row = yield* connections.one(id);
    return Option.isSome(row) ? row.value.status : undefined;
  });

const expiresAt = (millis: number): string => new Date(millis).toISOString();

/** Makes the token endpoint accept the refresh token `refresh-1` and issue an 8-hour token. */
const answerRefreshWithNewToken = (): void => {
  if (provider === undefined) throw new Error("run first");
  provider.answers.token = () =>
    buildJsonResponse({
      access_token: "refreshed-token",
      refresh_token: "refresh-2",
      token_type: "bearer",
      expires_in: 8 * 60 * 60,
    });
};

describe("the refreshing read of a GitHub Connection's token", () => {
  it("returns a token that is outside the refresh margin as it is, with its expiry", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(HOUR),
    };

    const read = await run({ tokens }, readToken);

    expect(read).toEqual({ token: "stored-token", login: LOGIN, expiresAt: expiresAt(HOUR) });
    expect(provider?.tokenRequests).toEqual([]);
  });

  it("refreshes a token inside the refresh margin, and returns the new token with the new expiry", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(5 * MINUTE),
    };

    const { first, second } = await run({ tokens }, (id) =>
      Effect.gen(function* () {
        answerRefreshWithNewToken();
        const first = yield* readToken(id);
        const second = yield* readToken(id);
        return { first, second };
      }),
    );

    const refreshed = { token: "refreshed-token", login: LOGIN, expiresAt: expiresAt(8 * HOUR) };
    expect(first).toEqual(refreshed);
    // The new tokens were stored, so the second read does not refresh again.
    expect(second).toEqual(refreshed);
    expect(provider?.tokenRequests).toEqual([
      { grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "device-client-1" },
    ]);
  });

  it("returns a pasted token with no expiry", async () => {
    const read = await run({ pat: "pasted-token" }, readToken);

    expect(read).toEqual({ token: "pasted-token", login: LOGIN, expiresAt: undefined });
  });

  it("returns a token set that has no expiry with no expiry", async () => {
    const read = await run({ tokens: { accessToken: "stored-token" } }, readToken);

    expect(read).toEqual({ token: "stored-token", login: LOGIN, expiresAt: undefined });
  });

  it("still reads the token of a Connection whose status is error", async () => {
    const read = await run({ status: "error", pat: "pasted-token" }, readToken);

    expect(read).toMatchObject({ token: "pasted-token" });
  });

  it("refuses a Connection that was deleted", async () => {
    const failure = await run({}, () =>
      Effect.flip(readToken("0199e0e7-0000-7000-8000-000000000000")),
    );

    expect(failure).toMatchObject({
      _tag: "GithubTokenUnavailable",
      reason: "the session's GitHub Connection no longer exists",
    });
  });

  it("refuses a disabled Connection, even when it holds a pasted token", async () => {
    const failure = await run({ status: "disabled", pat: "pasted-token" }, (id) =>
      Effect.flip(readToken(id)),
    );

    expect(failure).toMatchObject({
      _tag: "GithubTokenUnavailable",
      reason: "the Connection 'octocat' is disabled in Settings → Connections",
    });
  });

  it("refuses a Connection that needs reauth, even when it holds a pasted token and a fresh token set", async () => {
    const tokens = { accessToken: "stored-token", expiresAt: expiresAt(HOUR) };

    const failure = await run({ status: "needs-reauth", pat: "pasted-token", tokens }, (id) =>
      Effect.flip(readToken(id)),
    );

    expect(failure).toMatchObject({
      _tag: "GithubTokenUnavailable",
      reason: "the Connection 'octocat' needs reconnecting in Settings → Connections",
    });
  });

  it("refuses a Connection that holds no token", async () => {
    const failure = await run({}, (id) => Effect.flip(readToken(id)));

    expect(failure).toMatchObject({
      reason: "the Connection 'octocat' needs reconnecting in Settings → Connections",
    });
  });

  it("asks to reconnect, and marks the Connection needs-reauth, when GitHub refuses the refresh", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(5 * MINUTE),
    };

    const { failure, status } = await run({ tokens }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        const failure = yield* Effect.flip(readToken(id));
        return { failure, status: yield* readStatus(id) };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "GithubTokenUnavailable",
      reason: "the Connection 'octocat' needs reconnecting in Settings → Connections",
    });
    expect(status).toBe("needs-reauth");
  });

  it("says GitHub could not be reached, and leaves the status alone, when the refresh cannot reach it and the token has expired", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(-MINUTE),
    };

    const { failure, status } = await run({ tokens }, (id) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => provider?.stop());
        const failure = yield* Effect.flip(readToken(id));
        return { failure, status: yield* readStatus(id) };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "GithubTokenUnavailable",
      reason: "GitHub could not be reached to refresh the Connection 'octocat'",
    });
    expect(status).toBe("connected");
  });

  it("returns the token held, with its expiry, when the refresh cannot reach GitHub but the token has not expired yet", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(5 * MINUTE),
    };

    const { read, status } = await run({ tokens }, (id) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => provider?.stop());
        const read = yield* readToken(id);
        return { read, status: yield* readStatus(id) };
      }),
    );

    expect(read).toEqual({ token: "stored-token", login: LOGIN, expiresAt: expiresAt(5 * MINUTE) });
    expect(status).toBe("connected");
  });
});

describe("the plain read of a GitHub Connection's token", () => {
  it("returns a pasted token", async () => {
    const found = await run({ pat: "pasted-token" }, findToken);

    expect(found).toEqual(
      Option.some({ token: "pasted-token", login: LOGIN, expiresAt: undefined }),
    );
  });

  it("returns a token inside the refresh margin, since it has not expired yet", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(5 * MINUTE),
    };

    const found = await run({ tokens }, findToken);

    expect(found).toEqual(
      Option.some({ token: "stored-token", login: LOGIN, expiresAt: expiresAt(5 * MINUTE) }),
    );
  });

  it("returns no token once it has expired", async () => {
    const tokens = {
      accessToken: "stored-token",
      refreshToken: "refresh-1",
      expiresAt: expiresAt(-MINUTE),
    };

    const found = await run({ tokens }, findToken);

    expect(found).toEqual(Option.none());
  });

  it.each(["disabled", "needs-reauth"] as const)(
    "returns no token for a %s Connection, even when it holds a pasted token",
    async (status) => {
      const found = await run({ status, pat: "pasted-token" }, findToken);

      expect(found).toEqual(Option.none());
    },
  );
});
