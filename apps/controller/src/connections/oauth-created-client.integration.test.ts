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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { ConnectionValidationFailed, type CreatedOAuthClient } from "@hercule/plugin-host";
import type { ConnectionOAuthStartInput } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction } from "../db/testing";
import { SETUP_LIFETIME_MS } from "./oauth";
import { ConnectionTypes, type RegisteredConnectionType } from "./runtime";
import { ConnectionService } from "./service";
import { buildAccount, buildConnectionServiceStack, buildJsonResponse } from "./testing";

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
  readonly answers: Record<string, () => Response>;
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
): { readonly type: RegisteredConnectionType; readonly log: PluginLog } => {
  const log: PluginLog = { created: [], deleted: [] };
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
            fields: [{ name: "configToken", label: "Configuration token", secret: true }],
          },
          redirectUris: ["http://127.0.0.1/callback", "http://127.0.0.1/oauth/callback"],
        },
      },
      validate: (credentials) => {
        const token = credentials["accessToken"] ?? credentials["pat"] ?? "";
        return token.startsWith("good-")
          ? Effect.succeed(buildAccount(token))
          : Effect.fail(
              new ConnectionValidationFailed({ message: "that account is not accepted" }),
            );
      },
      createOAuthClient: (values) => {
        if (values["configToken"] === EXPIRED) {
          return Effect.fail(new ConnectionValidationFailed({ message: EXPIRED_MESSAGE }));
        }
        if (values["configToken"]?.startsWith("throws")) {
          return Effect.die(new Error(`could not use ${values["configToken"]}`));
        }
        log.created.push(values);
        const clientId = `made-${log.created.length}`;
        const client: CreatedOAuthClient = {
          clientId,
          deleteClient: Effect.sync(() => {
            log.deleted.push(clientId);
          }),
        };
        return Effect.succeed(client);
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
 * Runs a scenario over a fresh stack, as the user, on a test clock, with the
 * given types registered. `logs` collects every log line the controller
 * writes.
 */
const run = <A, E>(
  types: ReadonlyArray<RegisteredConnectionType>,
  scenario: Effect.Effect<A, E, ConnectionService | ConnectionTypes | SqlClient.SqlClient>,
  logs: Array<string> = [],
): Promise<A> => {
  const home = mkdtempSync(join(tmpdir(), "hercule-created-client-"));
  homes.push(home);
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(ConnectionTypes, (registry) => registry.replace(types)),
      scenario,
    ).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(buildConnectionServiceStack(home)),
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
        const path = yield* service.completeOAuth({ code: "the-code", state });
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
        const path = yield* service.completeOAuth({ code: "the-code", state });
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
      [
        fieldIssue("configToken", "give a value for Configuration token"),
        fieldIssue("other", "the type forge/forge has no such field: it takes configToken"),
      ],
    ],
    [
      "an empty field",
      { clientValues: { configToken: "   " } },
      [fieldIssue("configToken", "Configuration token cannot be empty")],
    ],
    [
      "an unknown field",
      { clientValues: { configToken: SENTINEL, extra: SENTINEL } },
      [fieldIssue("extra", "the type forge/forge has no such field: it takes configToken")],
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
    const everything = await run(
      [type],
      Effect.gen(function* () {
        const service = yield* ConnectionService;
        const seen: Array<unknown> = [];
        // A flow that ends in a Connection.
        const started = yield* service.startOAuth(startInput());
        seen.push(started);
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
      logs,
    );

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
