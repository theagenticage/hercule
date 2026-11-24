/**
 * Tests the redirect flow of a connection type whose plugin creates an OAuth
 * client for each Connection (`publicClient.createdAtSetup`), and the return
 * to an address on the user's own machine that finishes through
 * `connection.finishOAuth`:
 *
 * - the client the plugin created is the one the code exchange and every
 *   refresh use, and it is stored with the Connection and nowhere else;
 * - a reconnect without new values keeps the Connection's client, and one with
 *   values replaces it;
 * - only the caller that started a flow can finish it, and each kind of return
 *   (to the controller, to the user's machine) is finished only by its own
 *   operation;
 * - a client that ends up unused is deleted at the provider;
 * - the values the user pasted reach the plugin and nothing else.
 *
 * The service runs over a real database and the token endpoint is a real
 * in-test server, as in `oauth.integration.test.ts`. The tests call the service
 * directly, because they need a second actor and a test clock, which the HTTP
 * harness gives no way to switch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { ConnectionValidationFailed, type CreatedOAuthClient } from "@hercule/plugin-host";
import type { ConnectionOAuthStartInput } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { EntityObservationsLayer, IngestExecutorLayer, OpenSignalsLayer } from "../daemon/ingest";
import { holdWriter, withReadSnapshot } from "../db/client";
import { inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { PromotionState } from "../promotion";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { masterKeyLayer, SecretLayer, Secrets, secretsLayer, type SecretOwner } from "../secrets";
import { ConnectionEntityFacts } from "./entity-facts";
import { ConnectionObserver } from "./observer";
import { SETUP_LIFETIME_MS } from "./oauth";
import { ConnectionReferences } from "./references";
import { ConnectionTypes, ConnectionTypesLayer, type RegisteredConnectionType } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";
import { buildAccount, buildJsonResponse } from "./testing";

/** The tokens the in-test provider issues. */
const ACCESS_TOKEN = "good-first@account-1";
const REFRESH_TOKEN = "refresh-1";

/** What the user pastes for the client. Appears in no row, log line or error. */
const SENTINEL = "xoxe-sentinel-config-token-0123456789";

/** The value that makes the fake plugin refuse, as a provider refuses an expired configuration token. */
const EXPIRED = "expired-token";

/** The message the fake plugin refuses with. It never quotes the value. */
const EXPIRED_MESSAGE = "the provider refused the configuration token because it has expired";

const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const OTHER_REDIRECT_URI = "http://127.0.0.1:61000/callback";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SESSION = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["connection.manage"],
  profileGrants: ["connection.manage"],
  assistantId: null,
  agentId: null,
} as unknown as Actor;

const OTHER_SESSION = {
  ...SESSION,
  sessionId: "0199e0e7-0004-7000-8000-000000000000",
} as unknown as Actor;

let homes: Array<string> = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** The token endpoint of the in-test provider, which records each form it receives. */
interface Provider {
  readonly base: string;
  readonly requests: Array<Record<string, string>>;
  readonly answers: Record<string, () => Response | Promise<Response>>;
  readonly stop: () => Promise<void>;
}

let provider: Provider | undefined;
afterEach(async () => {
  await provider?.stop();
  provider = undefined;
});

const startProvider = (): Provider => {
  const requests: Array<Record<string, string>> = [];
  const answers: Provider["answers"] = {
    authorization_code: () =>
      buildJsonResponse({
        access_token: "good-first@account-1",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600,
      }),
    refresh_token: () =>
      buildJsonResponse({
        access_token: "good-refreshed@account-1",
        refresh_token: "refresh-2",
        token_type: "bearer",
        expires_in: 3600,
      }),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      requests.push(form);
      const answer = answers[form["grant_type"] ?? ""];
      return answer === undefined
        ? buildJsonResponse({ error: "unsupported_grant_type" }, 400)
        : answer();
    },
  });
  const started = {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    answers,
    stop: () => server.stop(true),
  };
  provider = started;
  return started;
};

/** What the fake plugin saw and did, which the tests read back. */
interface PluginLog {
  /** The values `createOAuthClient` was called with, in order. */
  readonly created: Array<Record<string, string>>;
  /** The client ids whose `deleteClient` ran. */
  readonly deleted: Array<string>;
  /**
   * While it holds a promise, a client's `deleteClient` waits for it before it
   * records the delete, so a test can act while the provider's delete is in
   * flight.
   */
  readonly deleteGate: { current: Promise<void> | undefined };
  /**
   * While it holds a promise, `createOAuthClient` answers only when it settles,
   * after the app exists at the provider, so a test can act while the provider
   * is creating it.
   */
  readonly createGate: { current: Promise<void> | undefined };
  /** How many more checks of the account fail, with a message that says the provider is down. */
  readonly validateFailures: {
    remaining: number;
    calls: number;
    echoTokens: boolean;
    /** What a failing check says. */
    message: string;
  };
}

/**
 * Builds the connection type of a plugin `forge`, whose client is created for
 * each Connection. It registers the controller's callback path and the
 * desktop catcher's path, both without a port, as Slack's manifest does.
 * `createOAuthClient` refuses `EXPIRED`, throws on `THROWS`, and otherwise
 * hands out `made-1`, `made-2` and so on.
 */
const buildCreatedClientType = (
  tokenBase: string,
  fieldName = "configToken",
): { readonly type: RegisteredConnectionType; readonly log: PluginLog } => {
  const log: PluginLog = {
    created: [],
    deleted: [],
    deleteGate: { current: undefined },
    createGate: { current: undefined },
    validateFailures: { remaining: 0, calls: 0, echoTokens: false, message: "Forge answered 502" },
  };
  const type: RegisteredConnectionType = {
    pluginId: "forge",
    contribution: {
      type: "forge/forge",
      displayName: "Forge",
      setup: [
        { kind: "oauth" },
        { kind: "credentials", fields: [{ name: "pat", label: "Personal token", secret: true }] },
      ],
      oauth: {
        authorizationUrl: "https://forge.test/authorize",
        tokenUrl: `${tokenBase}/token`,
        scopes: ["read"],
        publicClient: {
          createdAtSetup: {
            fields: [{ name: fieldName, label: "Configuration token", secret: true }],
          },
          redirectUris: ["http://127.0.0.1/callback", "http://127.0.0.1/oauth/callback"],
        },
      },
      // Each run of the check counts, because the controller runs the same check again.
      validate: (credentials) =>
        Effect.suspend(() => {
          log.validateFailures.calls += 1;
          if (log.validateFailures.remaining > 0) {
            log.validateFailures.remaining -= 1;
            // A check that quotes the tokens it was sent.
            return Effect.fail(
              new ConnectionValidationFailed({
                message: log.validateFailures.echoTokens
                  ? `Forge refused ${credentials["accessToken"] ?? ""} and ${REFRESH_TOKEN}`
                  : log.validateFailures.message,
              }),
            );
          }
          const token = credentials["accessToken"] ?? credentials["pat"] ?? "";
          return token.startsWith("good-")
            ? Effect.succeed(buildAccount(token))
            : Effect.fail(
                new ConnectionValidationFailed({ message: "that account is not accepted" }),
              );
        }),
      createOAuthClient: (values) => {
        const pasted = Object.hasOwn(values, fieldName) ? (values[fieldName] ?? "") : "";
        if (pasted === EXPIRED) {
          return Effect.fail(new ConnectionValidationFailed({ message: EXPIRED_MESSAGE }));
        }
        if (pasted.startsWith("throws")) {
          return Effect.die(new Error(`could not use ${pasted}`));
        }
        // A provider that reflects what it was sent in its refusal.
        if (pasted.startsWith("echo-")) {
          return Effect.fail(
            new ConnectionValidationFailed({
              message: `the provider refused the token ${pasted}: it is invalid`,
            }),
          );
        }
        log.created.push(values);
        const clientId = `made-${log.created.length}`;
        const client: CreatedOAuthClient = {
          clientId,
          deleteClient: Effect.andThen(
            Effect.promise(() => log.deleteGate.current ?? Promise.resolve()),
            Effect.sync(() => {
              log.deleted.push(clientId);
            }),
          ),
        };
        // The app exists at the provider now. The answer may come later.
        return Effect.andThen(
          Effect.promise(() => log.createGate.current ?? Promise.resolve()),
          Effect.succeed(client),
        );
      },
    },
    feeds: {},
  };
  return { type, log };
};

/** A type whose plugin ships its public client, registered at one fixed port, as Linear's is. */
const SHIPPED_TYPE: RegisteredConnectionType = {
  pluginId: "shipped",
  contribution: {
    type: "shipped/shipped",
    displayName: "Shipped",
    setup: [{ kind: "oauth" }],
    oauth: {
      authorizationUrl: "https://shipped.test/authorize",
      tokenUrl: "https://shipped.test/token",
      scopes: [],
      publicClient: {
        clientId: "shipped-client",
        redirectUris: ["http://127.0.0.1:4937/oauth/callback"],
      },
    },
    validate: () => Effect.succeed(buildAccount("good-x")),
  },
  feeds: {},
};

/** A type whose plugin has no public client: its client lives in the plugin's settings. */
const CONFIGURED_TYPE: RegisteredConnectionType = {
  pluginId: "configured",
  contribution: {
    type: "configured/configured",
    displayName: "Configured",
    setup: [{ kind: "oauth" }],
    oauth: {
      authorizationUrl: "https://c.test/authorize",
      tokenUrl: "https://c.test/token",
      scopes: [],
    },
    validate: () => Effect.succeed(buildAccount("good-x")),
  },
  feeds: {},
};

/**
 * What a scenario changes in the service's stack to reach an interleaving that
 * the public operations cannot reach.
 */
interface StackOptions {
  /** The observer the service reports a created Connection to. By default one that does nothing. */
  readonly observer?: ConnectionObserver["Service"];
  /**
   * Runs once, just before the first read of a Connection's token set by
   * `Secrets.get`, which is where a refresh reads the tokens beside the row, so
   * another operation can commit between the two reads. The effect is taken out
   * of the cell before it runs.
   */
  readonly beforeTokenRead?: { current: Effect.Effect<void> | undefined };
  /**
   * Runs once, when a Connection's token set is written, which happens inside
   * the transaction that writes the Connection, so a request can be interrupted
   * while its commit is on the way. The effect is taken out of the cell before
   * it runs.
   */
  readonly onTokenWrite?: { current: Effect.Effect<void> | undefined };
  /**
   * Makes the controller sealed, as it is after a promotion: work that waits for
   * the gate is answered with the seal at once, and `whenServing` never
   * returns. `answered.count` counts the work answered with the seal, so the
   * test can see that the sealed branch ran.
   */
  readonly sealed?: { readonly answered: { count: number } };
}

/**
 * Builds the connection service over the real repositories and a temporary
 * database, from the layers the production stack is made of, with the changes
 * of `options`.
 */
const buildStack = (home: string, options: StackOptions) => {
  const hooks = { read: options.beforeTokenRead, write: options.onTokenWrite };
  /** Takes the effect out of a cell, so a hook runs once. */
  const takeHook = (cell: { current: Effect.Effect<void> | undefined } | undefined) => {
    const hook = cell?.current;
    if (cell !== undefined) cell.current = undefined;
    return hook ?? Effect.void;
  };
  const realSecrets = secretsLayer.pipe(Layer.provide(masterKeyLayer("file")));
  const secrets =
    hooks.read === undefined && hooks.write === undefined
      ? realSecrets
      : Layer.effect(Secrets)(
          Effect.map(Secrets, (real) => ({
            ...real,
            get: (owner: SecretOwner, name: string) =>
              Effect.suspend(() =>
                Effect.andThen(
                  name === "oauth.tokens" ? takeHook(hooks.read) : Effect.void,
                  real.get(owner, name),
                ),
              ),
            set: (owner: SecretOwner, name: string, value: Redacted.Redacted<string>) =>
              Effect.suspend(() =>
                Effect.andThen(
                  name === "oauth.tokens" ? takeHook(hooks.write) : Effect.void,
                  real.set(owner, name, value),
                ),
              ),
          })),
        ).pipe(Layer.provide(realSecrets));
  const sealed = options.sealed;
  const promotion =
    sealed === undefined
      ? ServingPromotionStateLayer
      : Layer.effect(PromotionState)(
          Effect.map(PromotionState, (real): PromotionState["Service"] => ({
            ...real,
            whenServing: () => Effect.never,
            whenServingOr: (_work, onSealed) =>
              Effect.suspend(() => {
                sealed.answered.count += 1;
                return onSealed(undefined as never);
              }),
          })),
        ).pipe(Layer.provide(ServingPromotionStateLayer));
  return ConnectionServiceLayer.pipe(
    Layer.provide(Layer.succeed(ConnectionReferences)({ list: () => Effect.succeed([]) })),
    Layer.provide(
      Layer.succeed(ConnectionEntityFacts)({ recordFactsOfDeletion: (_id, deletion) => deletion }),
    ),
    Layer.provide(
      Layer.succeed(ConnectionObserver)(
        options.observer ?? {
          connectionCreated: () => Effect.void,
          connectionDeleted: () => Effect.void,
        },
      ),
    ),
    Layer.provideMerge(
      PluginHostLayer.pipe(
        Layer.provide([IngestExecutorLayer, OpenSignalsLayer, EntityObservationsLayer]),
      ),
    ),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secrets),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(PlatformEventsLayer),
    Layer.provideMerge(promotion),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

/**
 * Runs a scenario over a fresh stack, as the user, on a test clock, with the
 * given types registered. `logs` collects every log line the controller
 * writes.
 */
const run = <A, E>(
  types: ReadonlyArray<RegisteredConnectionType>,
  scenario: Effect.Effect<
    A,
    E,
    ConnectionService | ConnectionTypes | PromotionState | SqlClient.SqlClient
  >,
  options: { readonly logs?: Array<string>; readonly stack?: StackOptions } = {},
): Promise<A> => {
  const logs = options.logs ?? [];
  const home = mkdtempSync(join(tmpdir(), "hercule-created-client-"));
  homes.push(home);
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(ConnectionTypes, (registry) => registry.replace(types)),
      scenario,
    ).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(buildStack(home, options.stack ?? {})),
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>(({ message }) => {
            logs.push(JSON.stringify(message));
          }),
        ]),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );
};

/** Lets fibers that were waiting on the test clock or on a callback finish their work. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

/** The `state` of an authorization URL. */
const readState = (authorizationUrl: string): string =>
  new URL(authorizationUrl).searchParams.get("state") ?? "";

/** What the browser ends on when the user approves a flow whose redirect URI is `redirectUri`. */
const buildReturn = (redirectUri: string, authorizationUrl: string, code = "the-code"): string =>
  `${redirectUri}?code=${code}&state=${readState(authorizationUrl)}`;

/** Runs `effect` as another actor. */
const asActor = <A, E, R>(actor: Actor, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentActor, actor);

/**
 * The start input that creates a Connection of the forge type from a redirect
 * URI on the user's machine. A key set to `undefined` is left out, so a test
 * can drop one of the defaults.
 */
const startInput = (overrides: Record<string, unknown> = {}): ConnectionOAuthStartInput =>
  Object.fromEntries(
    Object.entries({
      type: "forge/forge",
      redirectUri: REDIRECT_URI,
      clientValues: { configToken: SENTINEL },
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as ConnectionOAuthStartInput;

/** Reads the stored client id of every Connection. */
const readStoredClientIds = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ readonly oauth_client_id: string | null }>`SELECT oauth_client_id FROM connections`.pipe(
    Effect.map((rows) => rows.map((row) => row.oauth_client_id)),
  ),
);

/** Returns the message of a refusal the service failed with. */
const readMessage = (failure: unknown): string =>
  (failure as { readonly error: { readonly message: string } }).error.message;

/** Reads the account name of every Connection. */
const readDisplayNames = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ readonly display_name: string }>`SELECT display_name FROM connections`.pipe(
    Effect.map((rows) => rows.map((row) => row.display_name)),
  ),
);

/** Reads every row of every table, as text, for a search for what must not be stored. */
const dumpDatabase = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.gen(function* () {
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
    const dumps: Array<string> = [];
    for (const { name } of tables) {
      const rows = yield* sql.unsafe(`SELECT * FROM "${name}"`);
      dumps.push(JSON.stringify(rows));
    }
    return dumps.join("\n");
  }),
);

describe("creating a Connection with a client the plugin creates", () => {
  it("signs in with the created client at the exact redirect URI, stores its id, and refreshes with it", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    token.answers["authorization_code"] = () =>
      buildJsonResponse({
        access_token: "good-first@account-1",
        refresh_token: "refresh-1",
        expires_in: 0,
      });

    const { authorizationUrl, connection, refreshed, stored } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const types = yield* ConnectionTypes;
        const started = yield* service.startOAuth(startInput({ label: "work" }));
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        const refreshed = yield* types.runtimeFor("forge").credentials(connection.id);
        return {
          authorizationUrl: new URL(started.authorizationUrl),
          connection,
          refreshed,
          stored: yield* readStoredClientIds,
        };
      }),
    );

    expect(log.created).toEqual([{ configToken: SENTINEL }]);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("made-1");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    const [exchange, refresh] = token.requests;
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "made-1",
      redirect_uri: REDIRECT_URI,
    });
    expect(exchange).not.toHaveProperty("client_secret");
    expect(refresh).toMatchObject({ grant_type: "refresh_token", client_id: "made-1" });
    expect(refresh).not.toHaveProperty("client_secret");
    expect(refreshed).toEqual({ accessToken: "good-refreshed@account-1" });
    expect(connection).toMatchObject({ type: "forge/forge", label: "work", status: "connected" });
    expect(stored).toEqual(["made-1"]);
  });

  it("accepts the bare query the browser ended on, as well as the whole address", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const connection = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        return yield* service.finishOAuth({
          callbackQuery: `?code=the-code&state=${readState(started.authorizationUrl)}`,
        });
      }),
    );

    expect(connection).toMatchObject({ status: "connected" });
  });

  it("stamps the Connection with the actor that started the flow", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const actors = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const started = yield* asActor(SESSION, service.startOAuth(startInput()));
        yield* asActor(
          SESSION,
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        return yield* sql<{ readonly actor: string }>`
          SELECT actor FROM events WHERE kind = 'connection.created'`;
      }),
    );

    expect(actors).toEqual([{ actor: `session:${(SESSION as { sessionId: string }).sessionId}` }]);
  });
});

describe("reconnecting a Connection that has a created client", () => {
  /** Creates a Connection with client `made-1` and returns its id. */
  const connect = Effect.gen(function* () {
    const service = yield* ConnectionService;
    const started = yield* service.startOAuth(startInput());
    const connection = yield* service.finishOAuth({
      callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
    });
    return connection.id;
  });

  it("signs in again with the Connection's own client when no values are given, and never deletes it", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { stored, created } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const connectionId = yield* connect;
        const started = yield* service.startOAuth({
          type: "forge/forge",
          redirectUri: REDIRECT_URI,
          connectionId,
        });
        expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("made-1");
        yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        // Past the lifetime of the flow, when a created client would be deleted.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS * 2));
        yield* settle;
        return { stored: yield* readStoredClientIds, created: log.created.length };
      }),
    );

    expect(created).toBe(1);
    expect(log.deleted).toEqual([]);
    expect(token.requests.at(-1)).toMatchObject({ client_id: "made-1" });
    expect(stored).toEqual(["made-1"]);
  });

  it("replaces the client when values are given, and signs in and refreshes with the new one", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    token.answers["authorization_code"] = () =>
      buildJsonResponse({
        access_token: "good-first@account-1",
        refresh_token: "refresh-1",
        expires_in: 0,
      });

    const { stored } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const types = yield* ConnectionTypes;
        const connectionId = yield* connect;
        const started = yield* service.startOAuth(
          startInput({ connectionId, clientValues: { configToken: "second-token" } }),
        );
        yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        yield* types.runtimeFor("forge").credentials(connectionId);
        return { stored: yield* readStoredClientIds };
      }),
    );

    expect(log.created).toEqual([{ configToken: SENTINEL }, { configToken: "second-token" }]);
    expect(stored).toEqual(["made-2"]);
    const [, exchange, refresh] = token.requests.filter((one) => one["client_id"] !== undefined);
    expect(exchange).toMatchObject({ grant_type: "authorization_code", client_id: "made-2" });
    expect(refresh).toMatchObject({ grant_type: "refresh_token", client_id: "made-2" });
    expect(log.deleted).toEqual([]);
  });

  it("refuses a reconnect that has no client yet and no values, and says what to paste", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const failure = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const connectionId = yield* connect;
        yield* inTransaction(sql`UPDATE connections SET oauth_client_id = NULL`);
        return yield* Effect.flip(
          service.startOAuth({ type: "forge/forge", redirectUri: REDIRECT_URI, connectionId }),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message:
          "this Connection has no app yet: paste a new configuration token to set it up again",
      },
    });
  });

  it("forgets the client when the user pastes credentials instead, because the tokens it belonged to are gone", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const stored = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const connectionId = yield* connect;
        yield* service.setCredentials({
          id: connectionId,
          credentials: { pat: "good-pasted@account-1" },
        });
        return yield* readStoredClientIds;
      }),
    );

    expect(stored).toEqual([null]);
  });

  it("writes nothing when the sign-in is for another account, keeps the old client, and deletes the new one", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { failure, stored, names } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const connectionId = yield* connect;
        const before = yield* readDisplayNames;
        const started = yield* service.startOAuth(
          startInput({ connectionId, clientValues: { configToken: "second-token" } }),
        );
        token.answers["authorization_code"] = () =>
          buildJsonResponse({
            access_token: "good-other@account-2",
            refresh_token: "refresh-x",
            expires_in: 3600,
          });
        const failure = yield* Effect.flip(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        const after = yield* readDisplayNames;
        return {
          failure,
          stored: yield* readStoredClientIds,
          names: { before, after },
        };
      }),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(stored).toEqual(["made-1"]);
    expect(names.after).toEqual(names.before);
    expect(log.deleted).toEqual(["made-2"]);
  });

  it("lets the first sign-in to finish win when two were started from the same credentials", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { failure, stored } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const connectionId = yield* connect;
        const older = yield* service.startOAuth(
          startInput({ connectionId, clientValues: { configToken: "older-token" } }),
        );
        const newer = yield* service.startOAuth(
          startInput({
            connectionId,
            redirectUri: OTHER_REDIRECT_URI,
            clientValues: { configToken: "newer-token" },
          }),
        );
        yield* service.finishOAuth({
          callbackQuery: buildReturn(OTHER_REDIRECT_URI, newer.authorizationUrl),
        });
        const failure = yield* Effect.flip(
          service.finishOAuth({ callbackQuery: buildReturn(REDIRECT_URI, older.authorizationUrl) }),
        );
        return { failure, stored: yield* readStoredClientIds };
      }),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    // The client the newer sign-in created (made-3) is the one the Connection keeps.
    expect(stored).toEqual(["made-3"]);
    expect(log.deleted).toEqual(["made-2"]);
  });
});

describe("who can finish a flow, and which operation finishes which flow", () => {
  it("lets only the caller that started the flow finish it, and leaves the flow open for that caller", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { wrongCaller, wrongSession, connection } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* asActor(SESSION, service.startOAuth(startInput()));
        const callbackQuery = buildReturn(REDIRECT_URI, started.authorizationUrl);
        const wrongCaller = yield* Effect.flip(service.finishOAuth({ callbackQuery }));
        const wrongSession = yield* Effect.flip(
          asActor(OTHER_SESSION, service.finishOAuth({ callbackQuery })),
        );
        const connection = yield* asActor(SESSION, service.finishOAuth({ callbackQuery }));
        return { wrongCaller, wrongSession, connection };
      }),
    );

    for (const failure of [wrongCaller, wrongSession]) {
      expect(failure).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["callbackQuery"] }] } },
      });
    }
    expect(connection).toMatchObject({ status: "connected" });
    expect(log.deleted).toEqual([]);
  });

  it("refuses a pasted address that is not the flow's redirect address, and keeps the flow open", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { refused, connection } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const refused = yield* Effect.flip(
          service.finishOAuth({
            callbackQuery: buildReturn(OTHER_REDIRECT_URI, started.authorizationUrl),
          }),
        );
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        return { refused, connection };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "validation" } });
    expect(connection).toMatchObject({ status: "connected" });
  });

  it("refuses text that is not a redirect answer, without claiming the flow", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { refused, connection } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const refused = yield* Effect.flip(
          service.finishOAuth({ callbackQuery: `state=${readState(started.authorizationUrl)}` }),
        );
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        return { refused, connection };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "validation" } });
    expect(connection).toMatchObject({ status: "connected" });
  });

  it("refuses to finish a flow that returns to the controller, and the controller's callback finishes it", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { refused, path, count } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(
          startInput({ redirectUri: undefined, origin: "http://127.0.0.1:4937" }),
        );
        const state = readState(started.authorizationUrl);
        const refused = yield* Effect.flip(
          service.finishOAuth({ callbackQuery: `code=the-code&state=${state}` }),
        );
        const path = yield* service.completeOAuth(`code=the-code&state=${state}`);
        const { items } = yield* service.query({});
        return { refused, path, count: items.length };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "validation" } });
    expect(path).toBe("/connections?oauth=ok");
    expect(count).toBe(1);
    expect(token.requests[0]).toMatchObject({
      redirect_uri: "http://127.0.0.1:4937/oauth/callback",
    });
  });

  it("refuses the controller's callback for a flow that returns to the user's machine, and keeps it open", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { path, connection } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const state = readState(started.authorizationUrl);
        const path = yield* service.completeOAuth(`code=the-code&state=${state}`);
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        return { path, connection };
      }),
    );

    expect(path).toBe("/connections?oauth=expired");
    expect(token.requests).toHaveLength(1);
    expect(connection).toMatchObject({ status: "connected" });
  });

  it("accepts a flow only once", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const second = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const callbackQuery = buildReturn(REDIRECT_URI, started.authorizationUrl);
        yield* service.finishOAuth({ callbackQuery });
        return yield* Effect.flip(service.finishOAuth({ callbackQuery }));
      }),
    );

    expect(second).toMatchObject({ error: { code: "validation" } });
  });
});

describe("the values the user pastes for the client", () => {
  /** The refusal of a key the type does not declare. It never quotes the key. */
  const UNKNOWN_FIELD_ISSUE = {
    path: ["clientValues"],
    message: "the type forge/forge takes only these fields: configToken",
  };
  const fieldIssue = (field: string, message: string) => ({
    path: ["clientValues", field],
    message,
  });

  it.each([
    [
      "no values for a new Connection",
      { clientValues: undefined },
      [
        {
          path: ["clientValues"],
          message:
            "give a value for each of configToken: Forge sets up an app of its own for each new Connection",
        },
      ],
    ],
    [
      "a missing field",
      { clientValues: { other: "x" } },
      [fieldIssue("configToken", "give a value for Configuration token"), UNKNOWN_FIELD_ISSUE],
    ],
    [
      "an empty field",
      { clientValues: { configToken: "   " } },
      [fieldIssue("configToken", "Configuration token cannot be empty")],
    ],
    [
      "an unknown field",
      { clientValues: { configToken: SENTINEL, extra: SENTINEL } },
      [UNKNOWN_FIELD_ISSUE],
    ],
    [
      "a token pasted where a field name belongs, in a key longer than any field name",
      { clientValues: { configToken: "fine-value", [`${"k".repeat(300)}${SENTINEL}`]: "x" } },
      [UNKNOWN_FIELD_ISSUE],
    ],
  ])("refuses %s, names the field, and creates nothing", async (_, overrides, issues) => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { failure, setups } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const failure = yield* Effect.flip(service.startOAuth(startInput(overrides)));
        const setups = yield* sql`SELECT state FROM oauth_setups`;
        return { failure, setups };
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation", details: { issues } } });
    expect(JSON.stringify(failure)).not.toContain(SENTINEL);
    expect(log.created).toEqual([]);
    expect(setups).toEqual([]);
  });

  it("refuses values for a type that creates no client", async () => {
    startProvider();

    const failure = await run(
      [SHIPPED_TYPE],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(
          service.startOAuth({
            type: "shipped/shipped",
            origin: "http://127.0.0.1:4937",
            clientValues: { configToken: SENTINEL },
          }),
        ),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["clientValues"] }] } },
    });
    expect(JSON.stringify(failure)).not.toContain(SENTINEL);
  });

  it("answers with the plugin's own message when the provider refuses, and stores no flow", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { failure, setups } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const failure = yield* Effect.flip(
          service.startOAuth(startInput({ clientValues: { configToken: EXPIRED } })),
        );
        return { failure, setups: yield* sql`SELECT state FROM oauth_setups` };
      }),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state", message: EXPIRED_MESSAGE } });
    expect(setups).toEqual([]);
  });

  it("keeps the values in no row, audit entry, log line, error or answer, whatever way the flow goes", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const logs: Array<string> = [];
    let pendingDump = "";
    const everything = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const seen: Array<unknown> = [];
        // A flow that ends in a Connection.
        const started = yield* service.startOAuth(startInput());
        seen.push(started);
        // While the flow is pending, its row is in `oauth_setups`.
        const whilePending = yield* dumpDatabase;
        expect(whilePending).toContain(readState(started.authorizationUrl));
        pendingDump = whilePending;
        seen.push(
          yield* service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        // A flow that ends when the user declines.
        const declined = yield* service.startOAuth(startInput());
        seen.push(
          yield* Effect.flip(
            service.finishOAuth({
              callbackQuery: `error=access_denied&state=${readState(declined.authorizationUrl)}`,
            }),
          ),
        );
        // A flow whose plugin fails, with the value in its own failure.
        seen.push(
          yield* Effect.flip(
            service.startOAuth(startInput({ clientValues: { configToken: `throws-${SENTINEL}` } })),
          ),
        );
        seen.push(
          yield* Effect.flip(
            service.startOAuth(
              startInput({ clientValues: { configToken: SENTINEL, extra: SENTINEL } }),
            ),
          ),
        );
        return JSON.stringify(seen) + (yield* dumpDatabase);
      }),
      { logs },
    );

    expect(pendingDump).not.toContain(SENTINEL);
    expect(everything).not.toContain(SENTINEL);
    expect(logs.join("\n")).not.toContain(SENTINEL);
  });
});

describe("the client a sign-in created and nothing used", () => {
  it("is deleted at the provider when the sign-in is never finished", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const beforeExpiry = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        yield* service.startOAuth(startInput());
        // The flow's lifetime is over, but a finish that claimed at its last
        // moment may still be exchanging the code: the grace period protects it.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS - 1000));
        yield* settle;
        const early = [...log.deleted];
        yield* TestClock.adjust(Duration.millis(2000));
        yield* settle;
        return early;
      }),
    );

    expect(beforeExpiry).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });

  it.each([
    ["the user declines", "error=access_denied"],
    ["the provider refuses the code", "code=refused"],
  ])("is deleted at the provider when %s", async (_, answer) => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    token.answers["authorization_code"] = () => buildJsonResponse({ error: "invalid_grant" }, 400);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        yield* Effect.flip(
          service.finishOAuth({
            callbackQuery: `${answer}&state=${readState(started.authorizationUrl)}`,
          }),
        );
        // The delete is not left to the timer.
        expect(log.deleted).toEqual(["made-1"]);
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS * 2));
        yield* settle;
      }),
    );

    // Deleted once: the timer did not delete it again.
    expect(log.deleted).toEqual(["made-1"]);
  });

  it("is kept when the sign-in succeeds, even after the flow's lifetime has passed", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS * 2));
        yield* settle;
      }),
    );

    expect(log.deleted).toEqual([]);
  });
});

describe("the redirect URI of a flow that returns to the user's machine", () => {
  it("is refused when the type's client registered another address, and the answer names the one that works", async () => {
    startProvider();

    const failure = await run(
      [SHIPPED_TYPE],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(service.startOAuth({ type: "shipped/shipped", redirectUri: REDIRECT_URI })),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("http://127.0.0.1:4937/oauth/callback");
  });

  it("is refused for a type whose plugin has no public client", async () => {
    startProvider();

    const failure = await run(
      [CONFIGURED_TYPE],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(
          service.startOAuth({ type: "configured/configured", redirectUri: REDIRECT_URI }),
        ),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("origin");
  });

  it("is checked against a fixed-port registration exactly, also when the flow returns to the controller", async () => {
    startProvider();

    const failure = await run(
      [SHIPPED_TYPE],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(
          service.startOAuth({ type: "shipped/shipped", origin: "http://127.0.0.1:4938" }),
        ),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
  });
});

/** Polls, in real time, until the effect answers true, for at most two seconds. */
const waitUntil = (condition: Effect.Effect<boolean, unknown, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 2000;
    while (!(yield* condition)) {
      if (Date.now() > deadline) throw new Error("the condition never held");
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
  });

describe("deciding whether to delete the client of a sign-in that did not end cleanly", () => {
  it("keeps the client of a Connection whose write committed, when the finish is interrupted afterwards", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    // The finish reports the new Connection to the observer after the write
    // committed, so an observer that never answers holds the finish there.
    const observer = {
      connectionCreated: () => Effect.never,
      connectionDeleted: () => Effect.void,
    };

    const stored = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const finish = yield* Effect.forkChild(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        yield* waitUntil(Effect.map(readStoredClientIds, (ids) => ids.length > 0));
        yield* Fiber.interrupt(finish);
        yield* settle;
        return yield* readStoredClientIds;
      }),
      { stack: { observer } },
    );

    expect(stored).toEqual(["made-1"]);
    expect(log.deleted).toEqual([]);
  });

  it("deletes the client when the finish is interrupted before the write", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const held = Promise.withResolvers<Response>();
    token.answers["authorization_code"] = () => held.promise;

    const stored = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const finish = yield* Effect.forkChild(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        yield* waitUntil(Effect.sync(() => token.requests.length > 0));
        yield* Fiber.interrupt(finish);
        yield* settle;
        return yield* readStoredClientIds;
      }),
    );
    held.resolve(buildJsonResponse({ error: "invalid_grant" }, 400));

    expect(stored).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("who owns the cleanup of a created client", () => {
  it("is the finish's, once it claimed the sign-in just before its lifetime ended, even when the lifetime is over while the code is exchanged", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const held = Promise.withResolvers<Response>();
    token.answers["authorization_code"] = () => held.promise;

    const connection = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS - 1000));
        const finish = yield* Effect.forkChild(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        yield* waitUntil(Effect.sync(() => token.requests.length > 0));
        // The sign-in's lifetime is over while the code is still being exchanged
        // (a request waits at most 30 seconds). The timer must not delete the
        // client under the finish.
        yield* TestClock.adjust(Duration.seconds(20));
        yield* settle;
        expect(log.deleted).toEqual([]);
        held.resolve(
          buildJsonResponse({
            access_token: "good-first@account-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
          }),
        );
        return yield* Fiber.join(finish);
      }),
    );

    expect(connection).toMatchObject({ status: "connected" });
    expect(log.deleted).toEqual([]);
  });

  it("is still the start's when the start is interrupted after the client was created: the client is deleted and no flow is stored", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { setups } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        // The writer is busy, so the start waits for it after it created the client.
        yield* Effect.forkChild(holdWriter(sql, Deferred.await(release)));
        yield* settle;
        const start = yield* Effect.forkChild(service.startOAuth(startInput()));
        yield* waitUntil(Effect.sync(() => log.created.length > 0));
        // The interrupt ends the start, which then deletes its row and its client,
        // and that needs the writer: so the writer is given back meanwhile.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(start));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
        yield* settle;
        return { setups: yield* sql`SELECT state FROM oauth_setups` };
      }),
    );

    expect(setups).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });

  it("is left alone by a controller that is frozen for a promotion, until it serves again", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const promotion = yield* PromotionState;
        yield* service.startOAuth(startInput());
        yield* promotion.freeze("promotion-1", new Date(Date.now() + 60_000));
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS * 2));
        yield* settle;
        expect(log.deleted).toEqual([]);
        yield* promotion.thaw("promotion-1");
        yield* settle;
      }),
    );

    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("the routine purge of expired setups", () => {
  it("leaves the row of a sign-in whose timer has not run yet, even after a large jump of the clock, so the timer still deletes its client", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const promotion = yield* PromotionState;
        yield* service.startOAuth(startInput());
        // The first sign-in's timer is due and waits at the gate of a frozen
        // controller, while the clock jumps two hours ahead.
        yield* promotion.freeze("promotion-1", new Date(Date.now() + 60_000));
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 2 * 60 * 60 * 1000));
        yield* settle;
        // A new start runs the routine purge of long expired rows, and must not
        // take the row whose client is still kept.
        yield* service.startOAuth(startInput({ redirectUri: OTHER_REDIRECT_URI }));
        yield* promotion.thaw("promotion-1");
        yield* settle;
      }),
    );

    // Only the first sign-in's client went. The second sign-in is still open.
    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("the expiry timer, when the clock does not agree with it", () => {
  it("does not delete anything while the clock, set back during a freeze, says the deadline has not come", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { afterThaw } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const promotion = yield* PromotionState;
        yield* service.startOAuth(startInput());
        yield* promotion.freeze("promotion-1", new Date(Date.now() + 60_000));
        // The timer wakes and waits at the gate.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
        // The clock is set back to before the deadline while it waits.
        yield* TestClock.setTime(1000);
        yield* promotion.thaw("promotion-1");
        yield* settle;
        const afterThaw = [...log.deleted];
        // Once the deadline really comes, the client goes.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
        return { afterThaw };
      }),
    );

    expect(afterThaw).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });

  it("leaves a client alone when someone else already deleted its row and has not taken the cleanup yet", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        yield* service.startOAuth(startInput());
        // What a successful claim has committed when its take of the cleanup is
        // still to come: the row is gone, and the cleanup is still kept.
        yield* inTransaction(sql`DELETE FROM oauth_setups`);
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
      }),
    );

    // The owner of the cleanup is whoever deleted the row, and it is not the timer.
    expect(log.deleted).toEqual([]);
  });
});

describe("the promotion gate, while an expired sign-in's client is being deleted", () => {
  it("is not held by the provider's delete, so a promotion can freeze the controller meanwhile", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const gate = Promise.withResolvers<void>();
    log.deleteGate.current = gate.promise;

    const { frozen } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const promotion = yield* PromotionState;
        yield* service.startOAuth(startInput());
        // The timer fires, deletes the row, and starts the provider's delete, which is held.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
        // A promotion freezes the controller by waiting for the work inside the
        // gate to finish: it must not wait for the provider.
        let frozen = false;
        const freezing = yield* Effect.forkChild(
          Effect.andThen(
            promotion.freeze("promotion-1", new Date(Date.now() + 60_000)),
            Effect.sync(() => {
              frozen = true;
            }),
          ),
        );
        yield* settle;
        const frozenBeforeDeleteEnded = frozen;
        gate.resolve();
        yield* Fiber.join(freezing);
        yield* settle;
        return { frozen: frozenBeforeDeleteEnded };
      }),
    );

    expect(frozen).toBe(true);
    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("an expired sign-in, while its client is being deleted at the provider", () => {
  it("cannot be finished, even if the clock is set back before its deadline, and no Connection is written", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const gate = Promise.withResolvers<void>();
    log.deleteGate.current = gate.promise;

    const { refused, connections, deletedWhileHeld } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const started = yield* service.startOAuth(startInput());
        const callbackQuery = buildReturn(REDIRECT_URI, started.authorizationUrl);
        // The timer comes due and starts to delete the client, which is held.
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
        // The clock is set back to before the deadline while the delete is in flight.
        yield* TestClock.setTime(1000);
        const refused = yield* Effect.flip(service.finishOAuth({ callbackQuery }));
        const connections = yield* sql`SELECT id FROM connections`;
        const deletedWhileHeld = [...log.deleted];
        gate.resolve();
        yield* settle;
        return { refused, connections, deletedWhileHeld };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "validation" } });
    expect(connections).toEqual([]);
    expect(deletedWhileHeld).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("the check of the account after the browser returns", () => {
  /** Starts a sign-in, finishes it while the account check fails `failures` times, and returns what the finish did. */
  const finishWithFailingChecks = (
    failures: number,
    echoTokens = false,
    message = "Forge answered 502",
  ) => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    log.validateFailures.remaining = failures;
    log.validateFailures.echoTokens = echoTokens;
    log.validateFailures.message = message;
    return run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        const finish = yield* Effect.forkChild(
          Effect.result(
            service.finishOAuth({
              callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
            }),
          ),
        );
        // The check waits one second and then two between its tries.
        for (const [index, wait] of [1, 2].entries()) {
          yield* waitUntil(Effect.sync(() => log.validateFailures.calls >= index + 1));
          yield* settle;
          yield* TestClock.adjust(Duration.seconds(wait));
        }
        return { result: yield* Fiber.join(finish), calls: log.validateFailures.calls };
      }),
    );
  };

  it("is tried again after a passing failure, and the Connection is written", async () => {
    const { result, calls } = await finishWithFailingChecks(2);

    expect(result._tag).toBe("Success");
    expect(calls).toBe(3);
  });

  it("removes the tokens from the plugin's message, because a check may quote what it was sent", async () => {
    const { result } = await finishWithFailingChecks(3, true);

    expect(result._tag).toBe("Failure");
    const message = readMessage((result as { failure: unknown }).failure);
    expect(message).toContain("checking the account failed: Forge refused [removed] and [removed]");
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(message).not.toContain(REFRESH_TOKEN);
  });

  it.each([
    ["a period", "Forge is down.", "Forge is down. Nothing was changed."],
    ["other punctuation", "Is Forge down?", "Is Forge down? Nothing was changed."],
    ["no punctuation", "Forge is down", "Forge is down. Nothing was changed."],
  ])("ends the plugin's message once, when it ends in %s", async (_, pluginMessage, expected) => {
    const { result } = await finishWithFailingChecks(3, false, pluginMessage);

    expect(result._tag).toBe("Failure");
    const message = readMessage((result as { failure: unknown }).failure);
    expect(message).toContain(`checking the account failed: ${expected}`);
    expect(message).not.toMatch(/[.!?]\.|\.\./);
  });

  it("passes the plugin's own message on when every try fails, and does not blame the account", async () => {
    const { result } = await finishWithFailingChecks(3);

    expect(result._tag).toBe("Failure");
    const message = readMessage((result as { failure: unknown }).failure);
    expect(message).toContain("checking the account failed: Forge answered 502.");
    expect(message).not.toContain("account you mean to use");
  });
});

describe("a start that is interrupted while the provider creates the app", () => {
  it("still deletes the app once the provider answers, and stores no sign-in", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const gate = Promise.withResolvers<void>();
    log.createGate.current = gate.promise;

    const { setups } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const start = yield* Effect.forkChild(service.startOAuth(startInput()));
        yield* waitUntil(Effect.sync(() => log.created.length > 0));
        // The request is cancelled while the provider is still creating the app.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(start));
        // The interrupt is waiting at the start, which cannot be cut short now.
        yield* settle;
        gate.resolve();
        yield* Fiber.join(interrupting);
        yield* settle;
        return { setups: yield* sql`SELECT state FROM oauth_setups` };
      }),
    );

    expect(setups).toEqual([]);
    expect(log.deleted).toEqual(["made-1"]);
  });

  it("says that an app may have been left at the provider when the plugin fails without saying why", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const failure = await run(
      [type],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(
          service.startOAuth(startInput({ clientValues: { configToken: "throws-now" } })),
        ),
      ),
    );

    expect(readMessage(failure)).toContain(
      "An app that this sign-in created may have been left at the provider",
    );
    expect(readMessage(failure)).not.toContain("An app named");
    expect(readMessage(failure)).not.toContain("throws-now");
  });
});

describe("a plugin's refusal when it creates the client", () => {
  it("shows the plugin's words with every pasted value removed from them", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);
    const pasted = "echo-0123456789-secret";

    const failure = await run(
      [type],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(service.startOAuth(startInput({ clientValues: { configToken: pasted } }))),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toBe("the provider refused the token [removed]: it is invalid");
  });

  it("reads a field the type names like an inherited property as missing, not as the inherited function", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base, "toString");

    const failure = await run(
      [type],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(service.startOAuth(startInput({ clientValues: { other: "x" } }))),
      ),
    );

    expect(failure).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [{ path: ["clientValues", "toString"] }, { path: ["clientValues"] }],
        },
      },
    });
  });
});

describe("the controller's callback for a flow that returns to the controller", () => {
  const ORIGIN = "http://127.0.0.1:4937";

  it.each([
    ["a blank code", (state: string) => `state=${state}&code=`, "denied"],
    ["a blank error", (state: string) => `state=${state}&error=`, "denied"],
    ["both a code and an error", (state: string) => `state=${state}&code=c&error=e`, "denied"],
    ["a parameter twice", (state: string) => `state=${state}&code=a&code=b`, "expired"],
    ["no state", () => "code=the-code", "expired"],
  ])("claims nothing for %s, so the real return still works", async (_, query, outcome) => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const { blank, real, exchanges } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(
          startInput({ redirectUri: undefined, origin: ORIGIN }),
        );
        const state = readState(started.authorizationUrl);
        const blank = yield* service.completeOAuth(query(state));
        const real = yield* service.completeOAuth(`state=${state}&code=the-code`);
        return { blank, real, exchanges: token.requests.length };
      }),
    );

    expect(blank).toBe(`/connections?oauth=${outcome}`);
    expect(real).toBe("/connections?oauth=ok");
    expect(exchanges).toBe(1);
  });

  it("still ends the flow when the provider denies it with an error and a state", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { denied, again } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(
          startInput({ redirectUri: undefined, origin: ORIGIN }),
        );
        const state = readState(started.authorizationUrl);
        const denied = yield* service.completeOAuth(`error=access_denied&state=${state}`);
        const again = yield* service.completeOAuth(`state=${state}&code=the-code`);
        return { denied, again };
      }),
    );

    expect(denied).toBe("/connections?oauth=denied");
    expect(again).toBe("/connections?oauth=expired");
    expect(log.deleted).toEqual(["made-1"]);
  });
});

describe("a refresh reads the Connection's row and tokens as one version", () => {
  it("never sends a refresh token with the client id of another version, when a reconnect commits between the two reads", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);
    const accessToken = "good-first@account-1";
    let issued = 0;
    token.answers["authorization_code"] = () => {
      issued += 1;
      return buildJsonResponse({
        access_token: accessToken,
        refresh_token: `refresh-${String(issued)}`,
        expires_in: 0,
      });
    };
    const hook: { current: Effect.Effect<void> | undefined } = { current: undefined };

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const types = yield* ConnectionTypes;
        const started = yield* service.startOAuth(startInput());
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
        });
        const again = yield* service.startOAuth(
          startInput({
            connectionId: connection.id,
            clientValues: { configToken: "second-token" },
          }),
        );
        // The reconnect commits after the refresh read the row and before it reads the tokens.
        hook.current = Effect.asVoid(
          Effect.orDie(
            service.finishOAuth({
              callbackQuery: buildReturn(REDIRECT_URI, again.authorizationUrl),
            }),
          ),
        );
        yield* Effect.ignore(types.runtimeFor("forge").credentials(connection.id));
      }),
      { stack: { beforeTokenRead: hook } },
    );

    const refreshes = token.requests
      .filter((request) => request["grant_type"] === "refresh_token")
      .map((request) => `${request["refresh_token"]}/${request["client_id"]}`);
    // Refresh token 1 belongs to client made-1 and refresh token 2 to made-2.
    expect(refreshes.length).toBeGreaterThan(0);
    for (const pair of refreshes) expect(["refresh-1/made-1", "refresh-2/made-2"]).toContain(pair);
  });
});

describe("the refusal when the app of a reconnect may be gone", () => {
  /** Connects, then reconnects with the Connection's own app while the provider refuses the code. */
  const reconnectRefused = (answer: string, values?: Record<string, string>) => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);
    return run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const first = yield* service.startOAuth(startInput());
        const connection = yield* service.finishOAuth({
          callbackQuery: buildReturn(REDIRECT_URI, first.authorizationUrl),
        });
        token.answers["authorization_code"] = () =>
          buildJsonResponse({ error: "invalid_client" }, 401);
        const again = yield* service.startOAuth({
          type: "forge/forge",
          redirectUri: REDIRECT_URI,
          connectionId: connection.id,
          ...(values === undefined ? {} : { clientValues: values }),
        });
        return yield* Effect.flip(
          service.finishOAuth({
            callbackQuery: `${answer}&state=${readState(again.authorizationUrl)}`,
          }),
        );
      }),
    );
  };

  it.each([
    ["the provider refuses the code", "code=the-code"],
    ["the user is sent back with an error", "error=access_denied"],
  ])("says to set the app up again, with the CLI way, when %s", async (_, answer) => {
    const failure = await reconnectRefused(answer);

    const message = readMessage(failure);
    // The first half is for whoever reads it in an app, and the CLI way comes second.
    expect(message).toContain(
      "set up the Forge app again: sign in again with a new configuration token",
    );
    expect(message.indexOf("set up the Forge app again")).toBeLessThan(
      message.indexOf("--client-values-stdin"),
    );
  });

  it("does not suggest it when the app was created for this very sign-in", async () => {
    const failure = await reconnectRefused("code=the-code", { configToken: "new-token" });

    expect(readMessage(failure)).not.toContain("app again");
  });
});

describe("the refusal of an origin the app does not accept", () => {
  it("sends the user to the desktop app or the paste flow, and lists no address without a port", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const failure = await run(
      [type],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(
          service.startOAuth(
            startInput({ redirectUri: undefined, origin: "http://hercule.example:4937" }),
          ),
        ),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("desktop app");
    expect(readMessage(failure)).toContain("paste");
    expect(readMessage(failure)).toContain("with its own port");
  });
});

describe("the clean-up of a created client, when the finish is cut short or the claim is slow", () => {
  it("keeps the client of a committed Connection, although a read snapshot older than the commit is open", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const committed = Promise.withResolvers<void>();
    // The observer is told after the commit and never answers, so the finish
    // stays there until it is interrupted.
    const observer = {
      connectionCreated: () =>
        Effect.andThen(
          Effect.sync(() => committed.resolve()),
          Effect.never,
        ),
      connectionDeleted: () => Effect.void,
    };

    const stored = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const releaseSnapshot = yield* Deferred.make<void>();
        const started = yield* service.startOAuth(startInput());
        // A reader whose view is older than the commit that is about to happen:
        // it has read once, which fixes the state it sees, and then it waits.
        const snapshotRead = Promise.withResolvers<void>();
        yield* Effect.forkChild(
          withReadSnapshot(
            sql,
            Effect.gen(function* () {
              yield* sql`SELECT count(*) AS connections FROM connections`;
              snapshotRead.resolve();
              yield* Deferred.await(releaseSnapshot);
            }),
          ),
        );
        yield* Effect.promise(() => snapshotRead.promise);
        const finish = yield* Effect.forkChild(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        yield* Effect.promise(() => committed.promise);
        yield* Fiber.interrupt(finish);
        yield* settle;
        yield* Deferred.succeed(releaseSnapshot, undefined);
        yield* settle;
        return yield* readStoredClientIds;
      }),
      { stack: { observer } },
    );

    expect(stored).toEqual(["made-1"]);
    expect(log.deleted).toEqual([]);
  });

  it("deletes the client once when a claim that waited for the writer comes after the deadline, and the timer is due", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { early, failure } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const started = yield* service.startOAuth(startInput());
        // The writer is busy, so the claim waits for it.
        yield* Effect.forkChild(holdWriter(sql, Deferred.await(release)));
        yield* settle;
        const finish = yield* Effect.forkChild(
          Effect.flip(
            service.finishOAuth({
              callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
            }),
          ),
        );
        yield* settle;
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
        const early = [...log.deleted];
        yield* Deferred.succeed(release, undefined);
        const failure = yield* Fiber.join(finish);
        yield* settle;
        return { early, failure };
      }),
    );

    // The timer fired and found the client claimed, so it deleted nothing.
    expect(early).toEqual([]);
    // The claim came too late, and the finish, which saw the deadline had passed, deleted the client.
    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(log.deleted).toEqual(["made-1"]);
  });

  it("leaves the client to the timer again when a claim by someone else is refused", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* asActor(SESSION, service.startOAuth(startInput()));
        const refused = yield* Effect.flip(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        expect(refused).toMatchObject({ error: { code: "validation" } });
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
      }),
    );

    expect(log.deleted).toEqual(["made-1"]);
  });

  it("keeps the client for the valid finish when another finish of the same sign-in is refused at the same time", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);

    const { refused, connection } = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const started = yield* asActor(SESSION, service.startOAuth(startInput()));
        const callbackQuery = buildReturn(REDIRECT_URI, started.authorizationUrl);
        // Both claims are in flight at once, waiting for the writer.
        yield* Effect.forkChild(holdWriter(sql, Deferred.await(release)));
        yield* settle;
        const wrong = yield* Effect.forkChild(
          Effect.flip(asActor(OTHER_SESSION, service.finishOAuth({ callbackQuery }))),
        );
        const right = yield* Effect.forkChild(
          asActor(SESSION, service.finishOAuth({ callbackQuery })),
        );
        yield* settle;
        yield* Deferred.succeed(release, undefined);
        return { refused: yield* Fiber.join(wrong), connection: yield* Fiber.join(right) };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "validation" } });
    expect(connection).toMatchObject({ status: "connected" });
    expect(log.deleted).toEqual([]);
  });

  it("never calls the provider for a client when the controller is sealed, and the sealed branch is the one that ran", async () => {
    const token = startProvider();
    const { type, log } = buildCreatedClientType(token.base);
    const answered = { count: 0 };

    await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        yield* service.startOAuth(startInput());
        yield* TestClock.adjust(Duration.millis(SETUP_LIFETIME_MS + 1000));
        yield* settle;
      }),
      { stack: { sealed: { answered } } },
    );

    // The timer reached the gate, was answered with the seal, and deleted nothing.
    expect(answered.count).toBe(1);
    expect(log.deleted).toEqual([]);
  });
});

describe("what the observer is told about a created Connection", () => {
  it("is told once, although the request is interrupted just as the commit finishes", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);
    const told: Array<string> = [];
    const observer = {
      connectionCreated: (created: { readonly connectionId: string }) =>
        Effect.sync(() => {
          told.push(created.connectionId);
        }),
      connectionDeleted: () => Effect.void,
    };
    const holder: { fiber?: Fiber.Fiber<unknown, unknown> } = {};
    // The interrupt is sent from inside the transaction that writes the
    // Connection, so it is delivered as soon as the transaction's
    // uninterruptible step ends, before anything after the commit can run.
    const onTokenWrite = {
      current: Effect.sync(() => {
        if (holder.fiber !== undefined) Effect.runFork(Fiber.interrupt(holder.fiber));
      }) as Effect.Effect<void> | undefined,
    };

    const stored = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const started = yield* service.startOAuth(startInput());
        holder.fiber = yield* Effect.forkChild(
          service.finishOAuth({
            callbackQuery: buildReturn(REDIRECT_URI, started.authorizationUrl),
          }),
        );
        yield* Fiber.await(holder.fiber);
        yield* settle;
        return yield* readStoredClientIds;
      }),
      { stack: { observer, onTokenWrite } },
    );

    expect(stored).toEqual(["made-1"]);
    expect(told).toHaveLength(1);
  });
});

describe("a plugin's refusal that quotes a short value of a field the type declares secret", () => {
  it("has the value removed, at any length", async () => {
    const token = startProvider();
    const { type } = buildCreatedClientType(token.base);

    const failure = await run(
      [type],
      Effect.flatMap(ConnectionService, (service) =>
        Effect.flip(service.startOAuth(startInput({ clientValues: { configToken: "echo-1" } }))),
      ),
    );

    expect(readMessage(failure)).toBe("the provider refused the token [removed]: it is invalid");
  });
});
