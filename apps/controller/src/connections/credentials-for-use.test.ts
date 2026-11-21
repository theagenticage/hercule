/**
 * Tests how the core reads a Connection's credentials to call an outside
 * server with them (`ConnectionTypes.readCredentialsForUse` and
 * `refreshAfterRejection`), over a real database and an in-test token
 * endpoint:
 *
 * - what a read returns for OAuth tokens and for pasted credentials, with the
 *   names of the secret ones, the Connection's config and an identity that never reveals the credentials;
 * - each way a read refuses, and the Connection status it leaves behind;
 * - the refresh after an outside server rejected the credentials: skipped when
 *   the stored credentials already changed, done once for concurrent callers,
 *   and refused, without touching the Connection, when there is nothing to
 *   refresh with;
 * - what a plugin reads: a stale token is refreshed whatever the Connection's
 *   status says, which only the core's own reads refuse.
 *
 * The clock is a `TestClock` at the epoch, so a token's expiry is set in
 * milliseconds after the epoch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import type * as SqlClient from "effect/sql/SqlClient";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase, inTransaction } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { readNotificationBodiesAbout } from "../notifications/testing";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { masterKeyLayer, Secrets, secretsLayer } from "../secrets";
import { OAUTH_TOKENS, serializeTokens, type TokenSet } from "./oauth";
import { PluginConfigs } from "./plugin-configs";
import { connectionRepository } from "./repository";
import { ConnectionTypes, ConnectionTypesLayer } from "./runtime";
import { buildJsonResponse, createDeviceProvider, type DeviceProvider } from "./testing";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SIGN_IN_TYPE = "oauthy/sign-in-type";
const PASTED_TYPE = "pasted/pasted-type";

let homes: Array<string> = [];
let provider: DeviceProvider | undefined;

afterEach(async () => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
  await provider?.stop();
  provider = undefined;
});

const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-credentials-for-use-"));
  homes.push(home);
  return ConnectionTypesLayer.pipe(
    Layer.provideMerge(Layer.succeed(PluginConfigs)({ of: () => Effect.succeed({}) })),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(ServingPromotionStateLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

/** What a test arranges for its Connection. */
interface Arrangement {
  readonly type?: typeof SIGN_IN_TYPE | typeof PASTED_TYPE;
  readonly status?: "disabled" | "needs-reauth";
  /** The stored config, which defaults to one that fits the type's schema. */
  readonly config?: Record<string, string>;
  /** The pasted credentials, by field name. */
  readonly pasted?: Record<string, string>;
  /** The token set a sign-in stored. */
  readonly tokens?: TokenSet;
}

/**
 * Registers a type that signs in through a device flow against the test
 * provider, and a type with pasted credentials, both with a config schema.
 * Stores a Connection as the arrangement says and runs `use` with its id.
 */
const run = <A, E>(
  arrangement: Arrangement,
  use: (id: string) => Effect.Effect<A, E, ConnectionTypes | Secrets | SqlClient.SqlClient>,
): Promise<A> => {
  const started = createDeviceProvider();
  provider = started;
  const configSchema = Schema.Struct({ region: Schema.String });
  const type = arrangement.type ?? SIGN_IN_TYPE;
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(ConnectionTypes, (types) =>
        types.replace([
          {
            pluginId: "oauthy",
            contribution: {
              type: SIGN_IN_TYPE,
              displayName: "Sign-in type",
              setup: [{ kind: "device" }],
              device: {
                clientId: "device-client-1",
                deviceCodeUrl: `${started.base}/device/code`,
                tokenUrl: `${started.base}/token`,
                scopes: [],
              },
              configSchema,
              validate: () => Effect.succeed({ displayName: "acct", accountId: "1" }),
            },
            feeds: {},
          },
          {
            pluginId: "pasted",
            contribution: {
              type: PASTED_TYPE,
              displayName: "Pasted type",
              setup: [
                {
                  kind: "credentials",
                  fields: [{ name: "apiKey", label: "API key", secret: true }],
                },
              ],
              configSchema,
              validate: () => Effect.succeed({ displayName: "acct", accountId: "1" }),
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
            pluginId: type === SIGN_IN_TYPE ? "oauthy" : "pasted",
            type,
            label: "work",
            displayName: "acct",
            accountId: "1",
            labels: [],
            config: arrangement.config ?? { region: "eu" },
            at,
          });
          const owner = { kind: "connection", id: row.id } as const;
          if (arrangement.status !== undefined) {
            yield* connections.update(row.id, { status: arrangement.status }, at);
          }
          for (const [name, value] of Object.entries(arrangement.pasted ?? {})) {
            yield* secrets.set(owner, name, Redacted.make(value));
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

const readForUse = (id: string) =>
  Effect.flatMap(ConnectionTypes, (types) => types.readCredentialsForUse(id));

const refreshAfterRejection = (id: string, rejectedIdentity: string) =>
  Effect.flatMap(ConnectionTypes, (types) => types.refreshAfterRejection(id, rejectedIdentity));

/** Stores a new token set for the Connection, as a sign-in or another refresh would. */
const storeTokens = (id: string, tokens: TokenSet) =>
  Effect.flatMap(Secrets, (secrets) =>
    inTransaction(
      secrets.set({ kind: "connection", id }, OAUTH_TOKENS, Redacted.make(serializeTokens(tokens))),
    ),
  );

const readStatus = (id: string) =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const row = yield* connections.one(id);
    return Option.isSome(row) ? row.value.status : undefined;
  });

const expiresAt = (millis: number): string => new Date(millis).toISOString();

const refreshRequests = () =>
  provider?.tokenRequests.filter((form) => form["grant_type"] === "refresh_token") ?? [];

/** Counts the Notifications that say a Connection needs signing in again. */
const countNeedsSignInNotifications = (id: string) =>
  Effect.map(
    readNotificationBodiesAbout("core.connection-error", { kind: "connection", id }),
    (bodies) => bodies.length,
  );

/** Reads the status detail of the Connection. */
const readStatusDetail = (id: string) =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const row = yield* connections.one(id);
    return Option.isSome(row) ? row.value.statusDetail : undefined;
  });

/** Makes the token endpoint accept `refresh-1` and issue a new token with a new refresh token. */
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

const FRESH_TOKENS: TokenSet = {
  accessToken: "stored-token",
  refreshToken: "refresh-1",
  expiresAt: expiresAt(HOUR),
};

const TOKENS_WITHOUT_REFRESH: TokenSet = {
  accessToken: "stored-token",
  expiresAt: expiresAt(HOUR),
};

const STALE_TOKENS: TokenSet = { ...FRESH_TOKENS, expiresAt: expiresAt(5 * MINUTE) };

describe("the credentials the core reads to call an outside server", () => {
  it("returns the access token of a signed-in Connection with its config, and an identity that is not the token", async () => {
    const read = await run({ tokens: FRESH_TOKENS }, readForUse);

    expect(read.credentials).toEqual({ accessToken: "stored-token" });
    expect(read.secretNames).toEqual(["accessToken"]);
    expect(read.config).toEqual({ region: "eu" });
    expect(read.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(read.identity).not.toContain("stored-token");
    expect(provider?.tokenRequests).toEqual([]);
  });

  it("returns pasted credentials with their config, and an identity that follows their values", async () => {
    const { first, again, replaced } = await run(
      { type: PASTED_TYPE, pasted: { apiKey: "key-1", region: "us" } },
      (id) =>
        Effect.gen(function* () {
          const first = yield* readForUse(id);
          const secrets = yield* Secrets;
          yield* inTransaction(
            secrets.set({ kind: "connection", id }, "apiKey", Redacted.make("key-2")),
          );
          return { first, again: yield* readForUse(id), replaced: yield* readForUse(id) };
        }),
    );

    expect(first.credentials).toEqual({ apiKey: "key-1", region: "us" });
    // Only the field the type marks `secret` is one; `region` only names something.
    expect(first.secretNames).toContain("apiKey");
    expect(first.secretNames).not.toContain("region");
    expect(first.config).toEqual({ region: "eu" });
    expect(again.credentials).toEqual({ apiKey: "key-2", region: "us" });
    expect(again.identity).not.toBe(first.identity);
    expect(replaced.identity).toBe(again.identity);
  });

  it("refreshes a token inside the refresh margin, and returns the new token with a new identity", async () => {
    const { before, after } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        const before = yield* readForUse(id);
        yield* storeTokens(id, STALE_TOKENS);
        answerRefreshWithNewToken();
        return { before, after: yield* readForUse(id) };
      }),
    );

    expect(after.credentials).toEqual({ accessToken: "refreshed-token" });
    expect(after.identity).not.toBe(before.identity);
    expect(refreshRequests()).toHaveLength(1);
  });

  it("fails with needs-sign-in, and marks the Connection needs-reauth, when the provider refuses the refresh", async () => {
    const { failure, status } = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        return { failure: yield* Effect.flip(readForUse(id)), status: yield* readStatus(id) };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "needs-sign-in",
    });
    expect(status).toBe("needs-reauth");
  });

  it("raises one Notification when the provider refuses the refresh, and puts no text of the provider in any message", async () => {
    const { failure, again, notifications, detail } = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        provider.answers.token = () =>
          buildJsonResponse(
            { error: "invalid_grant", error_description: "Bearer sk-live-leaked-text" },
            400,
          );
        const failure = yield* Effect.flip(readForUse(id));
        // The Connection is `needs-reauth` now, so this read refuses without the provider.
        const again = yield* Effect.flip(readForUse(id));
        return {
          failure,
          again,
          notifications: yield* countNeedsSignInNotifications(id),
          detail: yield* readStatusDetail(id),
        };
      }),
    );

    expect(notifications).toBe(1);
    expect(refreshRequests()).toHaveLength(1);
    for (const message of [failure.message, again.message, detail ?? ""]) {
      expect(message).not.toContain("invalid_grant");
      expect(message).not.toContain("sk-live-leaked-text");
    }
  });

  it("raises one Notification when a token has expired and its type cannot refresh", async () => {
    const notifications = await run({ type: PASTED_TYPE, tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        yield* Effect.flip(readForUse(id));
        return yield* countNeedsSignInNotifications(id);
      }),
    );

    expect(notifications).toBe(1);
  });

  it("never follows a redirect of the token endpoint, and reports an unreachable provider", async () => {
    const other = createDeviceProvider();
    try {
      const { failure, status } = await run({ tokens: STALE_TOKENS }, (id) =>
        Effect.gen(function* () {
          if (provider === undefined) throw new Error("run first");
          provider.answers.token = () =>
            new Response("send it on: client_secret=anything", {
              status: 307,
              headers: { location: `${other.base}/token` },
            });
          return { failure: yield* Effect.flip(readForUse(id)), status: yield* readStatus(id) };
        }),
      );

      expect(other.tokenRequests).toEqual([]);
      expect(failure).toMatchObject({
        _tag: "ConnectionCredentialsUnavailable",
        reason: "unreachable",
      });
      expect(failure.message).not.toContain("send it on");
      expect(status).toBe("connected");
    } finally {
      await other.stop();
    }
  });

  it("returns the new credentials, not an error, when the user reconnects while a refresh is in flight", async () => {
    const read = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        const requested = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        provider.answers.token = async () => {
          requested.resolve();
          await release.promise;
          return buildJsonResponse({
            access_token: "refreshed-token",
            refresh_token: "refresh-2",
            token_type: "bearer",
            expires_in: 8 * 60 * 60,
          });
        };
        const reading = yield* Effect.forkChild(readForUse(id));
        yield* Effect.promise(() => requested.promise);
        // The user signs in again while the provider is still answering.
        yield* storeTokens(id, { ...FRESH_TOKENS, accessToken: "reconnected-token" });
        release.resolve();
        return yield* Fiber.join(reading);
      }),
    );

    expect(read.credentials).toEqual({ accessToken: "reconnected-token" });
  });

  it("ignores the late refusal of a refresh when the user reconnected meanwhile and stored the same token set", async () => {
    const { read, status, notifications } = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        const requested = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let requests = 0;
        provider.answers.token = async () => {
          requests += 1;
          if (requests > 1) {
            return buildJsonResponse({
              access_token: "refreshed-token",
              refresh_token: "refresh-2",
              token_type: "bearer",
              expires_in: 8 * 60 * 60,
            });
          }
          requested.resolve();
          await release.promise;
          return buildJsonResponse({ error: "invalid_grant" }, 400);
        };
        const reading = yield* Effect.forkChild(readForUse(id));
        yield* Effect.promise(() => requested.promise);
        // The reconnect stores the very token set the refresh started from, so
        // only the Connection's credentials generation shows that it happened.
        const connections = yield* connectionRepository;
        yield* storeTokens(id, STALE_TOKENS);
        yield* inTransaction(
          connections.update(id, { replacesCredentials: true }, "2026-09-01T00:00:01.000Z"),
        );
        release.resolve();
        const read = yield* Fiber.join(reading);
        return {
          read,
          status: yield* readStatus(id),
          notifications: yield* countNeedsSignInNotifications(id),
        };
      }),
    );

    // The refusal belonged to the credentials before the reconnect, so the
    // read starts again with the reconnected ones and succeeds.
    expect(read.credentials).toEqual({ accessToken: "refreshed-token" });
    expect(status).toBe("connected");
    expect(notifications).toBe(0);
  });

  it("fails with unreachable, and leaves the Connection as it was, when the provider cannot be reached", async () => {
    const { failure, status } = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => provider?.stop());
        return { failure: yield* Effect.flip(readForUse(id)), status: yield* readStatus(id) };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "unreachable",
    });
    expect(status).toBe("connected");
  });

  it.each([
    { status: "disabled", reason: "switched-off" },
    { status: "needs-reauth", reason: "needs-sign-in" },
  ] as const)(
    "refuses a $status Connection with $reason, even when it holds fresh tokens, and calls no provider",
    async ({ status, reason }) => {
      const failure = await run({ status, tokens: FRESH_TOKENS }, (id) =>
        Effect.flip(readForUse(id)),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionCredentialsUnavailable", reason });
      expect(provider?.tokenRequests).toEqual([]);
    },
  );

  it("fails with no-credentials, and leaves the Connection connected, when a Connection without a sign-in flow holds no credentials", async () => {
    const { failure, status } = await run({ type: PASTED_TYPE }, (id) =>
      Effect.gen(function* () {
        return { failure: yield* Effect.flip(readForUse(id)), status: yield* readStatus(id) };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "no-credentials",
    });
    expect(status).toBe("connected");
  });

  it("fails with credentials-replaced, and leaves the Connection connected, when the user reconnects during the refresh and again during the repeat", async () => {
    const { failure, status, notifications } = await run({ tokens: STALE_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        let requests = 0;
        provider.answers.token = async () => {
          const turn = requests++;
          arrivals[turn]?.resolve();
          await releases[turn]?.promise;
          return buildJsonResponse({
            access_token: "refreshed-token",
            refresh_token: "refresh-2",
            token_type: "bearer",
            expires_in: 8 * 60 * 60,
          });
        };
        const reading = yield* Effect.forkChild(readForUse(id));
        for (const [turn, arrival] of arrivals.entries()) {
          yield* Effect.promise(() => arrival.promise);
          // The reconnect stores another token set that is still inside the refresh margin.
          yield* storeTokens(id, { ...STALE_TOKENS, accessToken: `reconnected-${String(turn)}` });
          releases[turn]?.resolve();
        }
        return {
          failure: yield* Effect.flip(Fiber.join(reading)),
          status: yield* readStatus(id),
          notifications: yield* countNeedsSignInNotifications(id),
        };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "credentials-replaced",
    });
    expect(status).toBe("connected");
    expect(notifications).toBe(0);
  });

  it("fails with missing for a Connection that does not exist", async () => {
    const failure = await run({}, () =>
      Effect.flip(readForUse("0199e0e7-0000-7000-8000-000000000000")),
    );

    expect(failure).toMatchObject({ _tag: "ConnectionCredentialsUnavailable", reason: "missing" });
  });

  it("fails with invalid-config when the stored config no longer fits the type's schema", async () => {
    const failure = await run({ tokens: FRESH_TOKENS, config: { zone: "eu" } }, (id) =>
      Effect.flip(readForUse(id)),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "invalid-config",
    });
  });
});

describe("the refresh after an outside server rejected the credentials", () => {
  it("returns the stored token without refreshing when it is no longer the rejected one", async () => {
    const { stored, rejected } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        const rejected = yield* readForUse(id);
        // Another caller refreshed, or the user signed in again, after the request went out.
        yield* storeTokens(id, { ...FRESH_TOKENS, accessToken: "newer-token" });
        return { rejected, stored: yield* refreshAfterRejection(id, rejected.identity) };
      }),
    );

    expect(stored.credentials).toEqual({ accessToken: "newer-token" });
    expect(stored.identity).not.toBe(rejected.identity);
    expect(provider?.tokenRequests).toEqual([]);
  });

  it("refreshes the rejected token now, even though it has not expired, and stores the new one", async () => {
    const { refreshed, rejected, later } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        answerRefreshWithNewToken();
        const rejected = yield* readForUse(id);
        const refreshed = yield* refreshAfterRejection(id, rejected.identity);
        return { rejected, refreshed, later: yield* readForUse(id) };
      }),
    );

    expect(refreshed.credentials).toEqual({ accessToken: "refreshed-token" });
    expect(refreshed.config).toEqual({ region: "eu" });
    expect(refreshed.identity).not.toBe(rejected.identity);
    expect(later.identity).toBe(refreshed.identity);
    expect(provider?.tokenRequests).toEqual([
      { grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "device-client-1" },
    ]);
  });

  it("refreshes once when two callers were rejected with the same token at the same time", async () => {
    const both = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        answerRefreshWithNewToken();
        const { identity } = yield* readForUse(id);
        return yield* Effect.all(
          [refreshAfterRejection(id, identity), refreshAfterRejection(id, identity)],
          { concurrency: "unbounded" },
        );
      }),
    );

    expect(refreshRequests()).toHaveLength(1);
    expect(both[0].credentials).toEqual({ accessToken: "refreshed-token" });
    expect(both[1]).toEqual(both[0]);
  });

  it("fails with needs-sign-in, and marks the Connection needs-reauth, when the provider refuses", async () => {
    const { failure, status } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        const { identity } = yield* readForUse(id);
        return {
          failure: yield* Effect.flip(refreshAfterRejection(id, identity)),
          status: yield* readStatus(id),
        };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "needs-sign-in",
    });
    expect(status).toBe("needs-reauth");
  });

  it("does not call the provider again for a caller that waited while another caller got the refresh refused", async () => {
    const { failures, status, notifications } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        if (provider === undefined) throw new Error("run first");
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        const { identity } = yield* readForUse(id);
        const failures = yield* Effect.all(
          [
            Effect.flip(refreshAfterRejection(id, identity)),
            Effect.flip(refreshAfterRejection(id, identity)),
          ],
          { concurrency: "unbounded" },
        );
        return {
          failures,
          status: yield* readStatus(id),
          notifications: yield* countNeedsSignInNotifications(id),
        };
      }),
    );

    expect(refreshRequests()).toHaveLength(1);
    expect(failures).toEqual([
      expect.objectContaining({ reason: "needs-sign-in" }),
      expect.objectContaining({ reason: "needs-sign-in" }),
    ]);
    expect(status).toBe("needs-reauth");
    expect(notifications).toBe(1);
  });

  it("fails with unreachable, and leaves the Connection as it was, when the provider cannot be reached", async () => {
    const { failure, status } = await run({ tokens: FRESH_TOKENS }, (id) =>
      Effect.gen(function* () {
        const { identity } = yield* readForUse(id);
        yield* Effect.promise(async () => provider?.stop());
        return {
          failure: yield* Effect.flip(refreshAfterRejection(id, identity)),
          status: yield* readStatus(id),
        };
      }),
    );

    expect(failure).toMatchObject({
      _tag: "ConnectionCredentialsUnavailable",
      reason: "unreachable",
    });
    expect(status).toBe("connected");
  });

  it("fails with ConnectionCannotRefresh, and changes nothing, when pasted credentials were rejected", async () => {
    const { failure, after } = await run({ type: PASTED_TYPE, pasted: { apiKey: "key-1" } }, (id) =>
      Effect.gen(function* () {
        const { identity } = yield* readForUse(id);
        return {
          failure: yield* Effect.flip(refreshAfterRejection(id, identity)),
          after: yield* readForUse(id),
        };
      }),
    );

    expect(failure).toMatchObject({ _tag: "ConnectionCannotRefresh" });
    expect(after.credentials).toEqual({ apiKey: "key-1" });
    expect(provider?.tokenRequests).toEqual([]);
  });

  it.each([
    ["OAuth tokens with no refresh token", SIGN_IN_TYPE, TOKENS_WITHOUT_REFRESH],
    ["OAuth tokens of a type with no refresh endpoint", PASTED_TYPE, FRESH_TOKENS],
  ] as const)(
    "fails with ConnectionCannotRefresh, and leaves the Connection alone with no Notification, for %s",
    async (_name, type, tokens) => {
      const { failure, status, notifications } = await run({ type, tokens }, (id) =>
        Effect.gen(function* () {
          const { identity } = yield* readForUse(id);
          return {
            failure: yield* Effect.flip(refreshAfterRejection(id, identity)),
            status: yield* readStatus(id),
            notifications: yield* countNeedsSignInNotifications(id),
          };
        }),
      );

      expect(failure).toMatchObject({ _tag: "ConnectionCannotRefresh" });
      expect(status).toBe("connected");
      expect(notifications).toBe(0);
      expect(provider?.tokenRequests).toEqual([]);
    },
  );

  it("returns pasted credentials the user replaced after the rejected request went out", async () => {
    const replaced = await run({ type: PASTED_TYPE, pasted: { apiKey: "key-1" } }, (id) =>
      Effect.gen(function* () {
        const { identity } = yield* readForUse(id);
        const secrets = yield* Secrets;
        yield* inTransaction(
          secrets.set({ kind: "connection", id }, "apiKey", Redacted.make("key-2")),
        );
        return yield* refreshAfterRejection(id, identity);
      }),
    );

    expect(replaced.credentials).toEqual({ apiKey: "key-2" });
  });
});

describe("the credentials a plugin reads", () => {
  it.each(["needs-reauth", "disabled"] as const)(
    "refreshes a stale token of a %s Connection, as it always did, where the core's own read refuses",
    async (status) => {
      const { read, coreRead } = await run({ tokens: STALE_TOKENS, status }, (id) =>
        Effect.gen(function* () {
          answerRefreshWithNewToken();
          const types = yield* ConnectionTypes;
          return {
            read: yield* types.runtimeFor("oauthy").credentials(id),
            coreRead: yield* Effect.flip(readForUse(id)),
          };
        }),
      );

      expect(read).toEqual({ accessToken: "refreshed-token" });
      expect(refreshRequests()).toHaveLength(1);
      expect(coreRead).toMatchObject({ _tag: "ConnectionCredentialsUnavailable" });
    },
  );
});
