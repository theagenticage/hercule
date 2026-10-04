/**
 * Tests the connection routes over a real socket, and the `ConnectionsRuntime`
 * a plugin is activated with, through the same controller that serves requests.
 *
 * The registry holds test plugins rather than the shipped one: a connection
 * type comes from a plugin, and these tests need a type whose `validate`
 * accepts or rejects on demand, plus other plugins whose connections must stay
 * out of reach.
 *
 * The tests that create a connection search every response body for the token
 * that went in, so a leak of the token fails them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type ActivationContext,
  type FeedDeclaration,
  type Plugin,
  type SetupStep,
} from "@hercule/plugin-host";
import {
  completeSetup,
  del,
  get,
  post,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import {
  buildAccount,
  buildAccountName,
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
    readonly details?: { readonly issues?: ReadonlyArray<{ path: ReadonlyArray<string> }> };
  };
}

/** The message the test type's `validate` fails with when it rejects a token. */
const REJECTED = "that token is not one this account knows";

/**
 * The tokens the test type accepts, and one it does not. `GOOD` and `ROTATED`
 * belong to one account under two names, as after a rename; `OTHER_ACCOUNT`
 * belongs to another account.
 */
const GOOD = "good-1";
const ROTATED = "good-2";
const OTHER_ACCOUNT = "good-3@account-2";
const BAD = "nope-1";

/** A valid id that no record was ever created with. */
const ABSENT = "0198e4b0-0000-7000-8000-0000000000ff";

/**
 * Builds a plugin that owns one connection type. `validate` accepts a token
 * that starts with `good-` and derives the account's display name from it.
 * That is all the routes need from a type: an accept, a reject, and a display
 * name that comes from the type.
 *
 * `type` is the bare word the plugin declares. Every request below uses the
 * qualified `<pluginId>/<word>` the host builds from it.
 */
const buildConnectionPlugin = (options: {
  readonly id: string;
  readonly type: string;
  readonly flow?: "credentials" | "oauth";
  readonly configSchema?: Schema.Top;
  /** When given, the plugin also declares an event source for the type, with these feeds. */
  readonly feeds?: Record<string, FeedDeclaration>;
}): TestPlugin => {
  const contexts: Array<ActivationContext> = [];
  const setup: ReadonlyArray<SetupStep> =
    options.flow === "oauth"
      ? [{ kind: "oauth" }]
      : [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }];
  const feeds = options.feeds;

  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: HOST_API,
      capabilities:
        feeds === undefined ? ["connections"] : ["connections", "event-sources", "events"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
      Effect.andThen(
        registerConnectionType(host, {
          type: options.type,
          displayName: `Type ${options.type}`,
          setup,
          ...(options.flow === "oauth"
            ? {
                oauth: {
                  authorizationUrl: "https://provider.test/authorize",
                  tokenUrl: "https://provider.test/token",
                  scopes: ["read"],
                },
              }
            : {}),
          ...(options.configSchema === undefined ? {} : { configSchema: options.configSchema }),
          validate: (credentials: Record<string, string>) => {
            const token = credentials["token"] ?? "";
            return token.startsWith("good-")
              ? Effect.succeed(buildAccount(token))
              : Effect.fail(new ConnectionValidationFailed({ message: REJECTED }));
          },
        }),
        feeds === undefined
          ? Effect.void
          : registerEventSource(host, {
              id: options.type,
              connectionType: `${options.id}/${options.type}`,
              kinds: {},
              feeds,
              // These tests are about the feeds' intervals, so the source polls nothing.
              open: () => Effect.succeed({ poll: () => Effect.succeed({}), close: Effect.void }),
            }),
      ),
    activate: (ctx) =>
      Effect.sync(() => {
        contexts.push(ctx);
        return Effect.void;
      }),
  };

  return { plugin, contexts };
};

/** Builds new plugins for each test, so no activation context outlives its test. */
const buildPlugins = () => ({
  main: buildConnectionPlugin({ id: "main", type: "main-type" }),
  other: buildConnectionPlugin({ id: "other", type: "other-type" }),
  configured: buildConnectionPlugin({
    id: "configured",
    type: "configured-type",
    configSchema: Schema.Struct({ watch: Schema.String }),
  }),
  oauth: buildConnectionPlugin({ id: "oauthy", type: "oauth-type", flow: "oauth" }),
  polled: buildConnectionPlugin({
    id: "polled",
    type: "polled-type",
    feeds: {
      fast: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
      slow: { defaultIntervalSeconds: 120 },
    },
  }),
});

type Registry = ReturnType<typeof buildPlugins>;

const withConnections = (
  body: (harness: ServerHarness, registry: Registry, token: string) => Promise<void>,
): Promise<void> => {
  const registry = buildPlugins();
  return withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      await body(harness, registry, token);
    },
    { plugins: Object.values(registry).map((one) => one.plugin) },
  );
};

const createConnection = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/connections", body, token);

/** Creates a connection and asserts that it worked, for tests that are about something else. */
const createConnectionOrFail = async (
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<ConnectionRecord> => {
  const response = await createConnection(base, token, {
    label: "work",
    labels: ["Code"],
    credentials: { token: GOOD },
    ...body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ConnectionRecord;
};

const readConnection = async (
  base: string,
  token: string,
  id: string,
): Promise<ConnectionRecord> => {
  const response = await get(base, `/api/v1/connections/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ConnectionRecord;
};

const readError = async (response: Response): Promise<ErrorBody["error"]> =>
  ((await response.json()) as ErrorBody).error;

describe("POST /connections", () => {
  it("creates a connected connection once the type accepts the token, and returns no credential value", async () => {
    await withConnections(async ({ base, audit, sql }, _registry, token) => {
      const response = await createConnection(base, token, {
        type: "main/main-type",
        label: "work",
        labels: ["Code"],
        config: {},
        credentials: { token: GOOD },
      });

      expect(response.status).toBe(201);
      const text = await response.clone().text();
      const record = (await response.json()) as ConnectionRecord;
      expect(record).toMatchObject({
        type: "main/main-type",
        label: "work",
        displayName: buildAccountName(GOOD),
        status: "connected",
        labels: ["Code"],
        config: {},
        credentials: [{ name: "token" }],
      });
      expect(record.id).toEqual(expect.any(String));
      expect(record.createdAt).toEqual(expect.any(String));
      expect(record.updatedAt).toEqual(expect.any(String));
      expect(text).not.toContain(GOOD);

      const rows = await Effect.runPromise(
        Effect.orDie(
          sql<{ readonly owner_id: string; readonly name: string }>`
            SELECT owner_id, name FROM secrets WHERE owner_kind = 'connection'
          `,
        ),
      );
      expect(rows).toEqual([{ owner_id: record.id, name: "token" }]);

      const entries = await audit("connection.created");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(JSON.stringify(entries[0]?.payload)).not.toContain(GOOD);
    });
  });

  it("returns the type's message at the field, and writes nothing, when the type rejects the token", async () => {
    await withConnections(async ({ base, sql }, _registry, token) => {
      const response = await createConnection(base, token, {
        type: "main/main-type",
        label: "work",
        labels: ["Code"],
        credentials: { token: BAD },
      });

      const error = await readError(response);
      expect(error.code).toBe("validation");
      expect(error.details?.issues).toContainEqual(
        expect.objectContaining({ path: ["credentials", "token"], message: REJECTED }),
      );

      expect(await (await get(base, "/api/v1/connections", token)).json()).toMatchObject({
        items: [],
      });
      const rows = await Effect.runPromise(
        Effect.orDie(sql`SELECT id FROM secrets WHERE owner_kind = 'connection'`),
      );
      expect(rows).toEqual([]);
    });
  });

  it("refuses the token, and names the plugin bug, when the type returns an empty account id", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      // Nothing follows the `@`, so the test type returns an empty account id.
      const response = await createConnection(base, token, {
        type: "main/main-type",
        credentials: { token: "good-1@" },
      });

      const error = await readError(response);
      expect(error.code).toBe("validation");
      expect(error.details?.issues).toContainEqual({
        path: ["credentials", "token"],
        message:
          "the connection type main/main-type returned an empty account id, so the account " +
          "cannot be checked on a reconnect. This is a bug in the plugin main: report it to " +
          "its author",
      });
      expect(await listConnections(base, token)).toEqual([]);
    });
  });

  it("names a connection given no label after its account, and gives it no topic", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const response = await createConnection(base, token, {
        type: "main/main-type",
        credentials: { token: GOOD },
      });

      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        label: buildAccountName(GOOD),
        displayName: buildAccountName(GOOD),
        labels: [],
        config: {},
      });
    });
  });

  it("accepts an empty topic list", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const response = await createConnection(base, token, {
        type: "main/main-type",
        label: "work",
        labels: [],
        credentials: { token: GOOD },
      });

      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({ label: "work", labels: [] });
    });
  });

  it("rejects an unknown type and a missing declared field", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const bodies = [
        { type: "nobody-type", label: "work", labels: ["Code"], credentials: { token: GOOD } },
        { type: "main/main-type", label: "work", labels: ["Code"], credentials: {} },
      ];

      for (const body of bodies) {
        const error = await readError(await createConnection(base, token, body));
        expect(error.code, JSON.stringify(body)).toBe("validation");
      }
    });
  });

  it("rejects a type whose setup is an OAuth flow, and says to start the OAuth flow instead", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const error = await readError(
        await createConnection(base, token, {
          type: "oauthy/oauth-type",
          label: "work",
          labels: ["Code"],
          credentials: {},
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.message.toLowerCase()).toContain("oauth");
    });
  });
});

describe("GET /connections", () => {
  it("filters by type and by status, and reads one connection back with credential names but no values", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const mine = await createConnectionOrFail(base, token, { type: "main/main-type" });
      const theirs = await createConnectionOrFail(base, token, {
        type: "other/other-type",
        label: "theirs",
      });
      await Effect.runPromise(
        readConnectionsSurface(registry.other).report(theirs.id, {
          status: "error",
          detail: "rate limited",
        }),
      );

      const byType = await get(base, "/api/v1/connections?type=main/main-type", token);
      expect(byType.status).toBe(200);
      const typed = (await byType.json()) as { items: ReadonlyArray<ConnectionRecord> };
      expect(typed.items.map((one) => one.id)).toEqual([mine.id]);

      const byStatus = await get(base, "/api/v1/connections?status=error", token);
      const statused = (await byStatus.json()) as { items: ReadonlyArray<ConnectionRecord> };
      expect(statused.items.map((one) => one.id)).toEqual([theirs.id]);

      const one = await get(base, `/api/v1/connections/${mine.id}`, token);
      const text = await one.clone().text();
      expect(((await one.json()) as ConnectionRecord).credentials).toEqual([{ name: "token" }]);
      expect(text).not.toContain(GOOD);
    });
  });

  it("returns not_found for an id that does not exist", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      // Create one connection first, so a 404 from a missing route cannot be
      // mistaken for a 404 about this id.
      await createConnectionOrFail(base, token, { type: "main/main-type" });

      const response = await get(base, `/api/v1/connections/${ABSENT}`, token);

      expect(response.status).toBe(404);
      expect(await readError(response)).toMatchObject({ code: "not_found" });
    });
  });
});

describe("PATCH /connections/:id", () => {
  const patchConnection = (
    base: string,
    token: string,
    id: string,
    body: unknown,
  ): Promise<Response> => send("PATCH", base, `/api/v1/connections/${id}`, { body, token });

  it("updates the label and topics, and leaves the account, status and credentials unchanged", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const before = await createConnectionOrFail(base, token, { type: "main/main-type" });

      const response = await patchConnection(base, token, before.id, {
        label: "personal",
        labels: ["Business"],
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const after = (await response.json()) as ConnectionRecord;
      expect(after).toMatchObject({
        id: before.id,
        label: "personal",
        labels: ["Business"],
        displayName: before.displayName,
        status: before.status,
        credentials: before.credentials,
        createdAt: before.createdAt,
      });
      expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    });
  });

  it("renames a connection named after its account, and keeps the account name", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const created = await createConnection(base, token, {
        type: "main/main-type",
        credentials: { token: GOOD },
      });
      const before = (await created.json()) as ConnectionRecord;

      const response = await patchConnection(base, token, before.id, { label: "personal" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        label: "personal",
        displayName: buildAccountName(GOOD),
      });
    });
  });

  it("removes every topic when given an empty topic list", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });

      const response = await patchConnection(base, token, one.id, { labels: [] });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ label: one.label, labels: [] });
    });
  });

  it("rejects a config that does not match the type's schema", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, {
        type: "configured/configured-type",
        config: { watch: "a" },
      });

      const wrong = await readError(
        await patchConnection(base, token, one.id, { config: { watch: 7 } }),
      );
      expect(wrong.code).toBe("validation");
      expect(wrong.details?.issues).toContainEqual(
        expect.objectContaining({ path: ["config", "watch"] }),
      );
    });
  });

  it("returns invalid_state for a connection whose type no plugin in this build defines", async () => {
    await withConnections(async ({ base, sql }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      // Simulate a build that dropped the plugin defining the type. A running
      // controller cannot get into this state, so the row is edited directly.
      await Effect.runPromise(
        sql`UPDATE connections SET type = 'gone-type' WHERE type = 'main/main-type'`.pipe(
          Effect.orDie,
        ),
      );

      const refused = await readError(await patchConnection(base, token, one.id, { config: {} }));

      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toContain("gone-type");
    });
  });

  it("accepts only an empty config for a type with no config schema", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });

      const empty = await patchConnection(base, token, one.id, { config: {} });
      expect(empty.status, await empty.clone().text()).toBe(200);

      const filled = await patchConnection(base, token, one.id, { config: { watch: "a" } });
      expect(await readError(filled)).toMatchObject({ code: "validation" });
    });
  });

  it("stores the user's poll intervals, returns them, and puts every feed back on its default with {}", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "polled/polled-type" });
      expect(one.feedIntervals).toEqual({});

      const set = await patchConnection(base, token, one.id, {
        feedIntervals: { fast: 30, slow: 600 },
      });
      expect(set.status, await set.clone().text()).toBe(200);
      expect(await set.json()).toMatchObject({ feedIntervals: { fast: 30, slow: 600 } });
      expect((await readConnection(base, token, one.id)).feedIntervals).toEqual({
        fast: 30,
        slow: 600,
      });

      // The map is replaced whole, so a feed left out goes back to its default.
      const narrowed = await patchConnection(base, token, one.id, { feedIntervals: { slow: 600 } });
      expect(await narrowed.json()).toMatchObject({ feedIntervals: { slow: 600 } });

      const cleared = await patchConnection(base, token, one.id, { feedIntervals: {} });
      expect(cleared.status, await cleared.clone().text()).toBe(200);
      expect((await readConnection(base, token, one.id)).feedIntervals).toEqual({});
    });
  });

  it("refuses an interval shorter than the feed allows, at that feed, and stores nothing", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "polled/polled-type" });

      // `fast` declares a shortest interval of 30 seconds; `slow` declares
      // none, so its default of 120 seconds is also its shortest.
      const refused = await readError(
        await patchConnection(base, token, one.id, {
          label: "renamed",
          feedIntervals: { fast: 29, slow: 119 },
        }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.details?.issues).toEqual([
        {
          path: ["feedIntervals", "fast"],
          message:
            "Poll fast every 30 seconds or slower; Type polled-type does not allow a shorter interval.",
        },
        {
          path: ["feedIntervals", "slow"],
          message:
            "Poll slow every 120 seconds or slower; Type polled-type does not allow a shorter interval.",
        },
      ]);
      expect(refused.message).toContain("Poll fast every 30 seconds or slower");
      expect(await readConnection(base, token, one.id)).toMatchObject({
        label: one.label,
        feedIntervals: {},
      });

      const shortest = await patchConnection(base, token, one.id, {
        feedIntervals: { fast: 30, slow: 120 },
      });
      expect(shortest.status, await shortest.clone().text()).toBe(200);
    });
  });

  it("refuses a feed the type does not declare, and any feed for a type with no feeds", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const polled = await createConnectionOrFail(base, token, { type: "polled/polled-type" });
      const unknown = await readError(
        await patchConnection(base, token, polled.id, { feedIntervals: { hourly: 3600 } }),
      );
      expect(unknown.code).toBe("validation");
      expect(unknown.details?.issues).toEqual([
        {
          path: ["feedIntervals", "hourly"],
          message: "Type polled-type has no feed named hourly. Its feeds are fast, slow.",
        },
      ]);

      const plain = await createConnectionOrFail(base, token, { type: "main/main-type" });
      const none = await readError(
        await patchConnection(base, token, plain.id, { feedIntervals: { fast: 60 } }),
      );
      expect(none.details?.issues).toEqual([
        {
          path: ["feedIntervals", "fast"],
          message: "Type main-type has no feeds to poll, so it takes no poll intervals.",
        },
      ]);
      const empty = await patchConnection(base, token, plain.id, { feedIntervals: {} });
      expect(empty.status, await empty.clone().text()).toBe(200);
    });
  });

  it("refuses an interval that is not a whole number of seconds from one to a day", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "polled/polled-type" });

      for (const seconds of [0, 90.5, 86_401]) {
        const refused = await readError(
          await patchConnection(base, token, one.id, { feedIntervals: { slow: seconds } }),
        );
        expect(refused.code, String(seconds)).toBe("validation");
      }
      const day = await patchConnection(base, token, one.id, { feedIntervals: { slow: 86_400 } });
      expect(day.status, await day.clone().text()).toBe(200);
    });
  });
});

describe("POST /connections/:id/credentials", () => {
  const setCredentials = (
    base: string,
    token: string,
    id: string,
    credentials: Record<string, string>,
  ): Promise<Response> =>
    post(base, `/api/v1/connections/${id}/credentials`, { credentials }, token);

  it("sets a connection that needed reauthentication back to connected, keeps its id, label and topics, and takes the new name of the same account", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      await Effect.runPromise(
        readConnectionsSurface(registry.main).report(one.id, { status: "needs-reauth" }),
      );

      const response = await setCredentials(base, token, one.id, { token: ROTATED });

      expect(response.status, await response.clone().text()).toBe(200);
      const after = (await response.json()) as ConnectionRecord;
      expect(after).toMatchObject({
        id: one.id,
        label: one.label,
        labels: one.labels,
        status: "connected",
        displayName: buildAccountName(ROTATED),
      });
      expect(after.credentials[0]?.name).toBe("token");
      expect(after.credentials[0]?.rotatedAt).toEqual(expect.any(String));
    });
  });

  it("leaves the connection unchanged when the type rejects the new token", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      await Effect.runPromise(
        readConnectionsSurface(registry.main).report(one.id, { status: "needs-reauth" }),
      );

      const response = await setCredentials(base, token, one.id, { token: BAD });

      expect(await readError(response)).toMatchObject({ code: "validation" });
      const after = await readConnection(base, token, one.id);
      expect(after).toMatchObject({
        status: "needs-reauth",
        displayName: one.displayName,
        credentials: [{ name: "token" }],
      });
      expect(after.credentials[0]?.rotatedAt).toBeUndefined();
    });
  });

  it("refuses credentials for another account, names both accounts, and leaves the connection unchanged", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      const surface = readConnectionsSurface(registry.main);
      await Effect.runPromise(surface.report(one.id, { status: "needs-reauth" }));

      const response = await setCredentials(base, token, one.id, { token: OTHER_ACCOUNT });

      expect(await readError(response)).toEqual({
        code: "invalid_state",
        message:
          `the account ${buildAccountName(OTHER_ACCOUNT)} is not the account this connection ` +
          `belongs to (last signed in as ${buildAccountName(GOOD)}). A reconnect must stay with ` +
          "the same account, because the connection's triggers and resources are tied to it. " +
          "Reconnect with that account, or create a new connection for " +
          buildAccountName(OTHER_ACCOUNT),
      });
      expect(await readConnection(base, token, one.id)).toMatchObject({
        status: "needs-reauth",
        displayName: one.displayName,
      });
      expect(await Effect.runPromise(surface.credentials(one.id))).toEqual({ token: GOOD });
    });
  });
});

describe("DELETE /connections/:id", () => {
  it("deletes the connection and every secret it owned", async () => {
    await withConnections(async ({ base, audit, secrets }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      // The test type takes one credential, and the API refuses to write a
      // connection's secrets, so the second secret goes in through the repository.
      await Effect.runPromise(
        secrets.set({ kind: "connection", id: one.id }, "extra", Redacted.make("another-value")),
      );

      const response = await del(base, `/api/v1/connections/${one.id}`, token);

      expect(response.status, await response.clone().text()).toBe(200);
      expect((await get(base, `/api/v1/connections/${one.id}`, token)).status).toBe(404);
      const left = await get(base, `/api/v1/secrets?ownerKind=connection&ownerId=${one.id}`, token);
      expect(await left.json()).toEqual({ items: [] });

      const entries = await audit("connection.deleted");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });
});

describe("the ConnectionsRuntime a plugin is activated with", () => {
  it("lists the plugin's own connections, without credentials", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const mine = await createConnectionOrFail(base, token, { type: "main/main-type" });
      await createConnectionOrFail(base, token, { type: "other/other-type" });

      const listed = await Effect.runPromise(readConnectionsSurface(registry.main).list());

      expect(listed.map((one) => one.id)).toEqual([mine.id]);
      expect(listed[0]).toMatchObject({
        id: mine.id,
        type: "main/main-type",
        label: mine.label,
        status: "connected",
        labels: ["Code"],
        config: {},
      });
      expect(JSON.stringify(listed)).not.toContain(GOOD);
    });
  });

  it("returns the credentials of its own connection, and reports a status the API then returns", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const mine = await createConnectionOrFail(base, token, { type: "main/main-type" });
      const surface = readConnectionsSurface(registry.main);

      expect(await Effect.runPromise(surface.credentials(mine.id))).toEqual({ token: GOOD });

      await Effect.runPromise(surface.report(mine.id, { status: "error", detail: "rate limited" }));
      expect(await readConnection(base, token, mine.id)).toMatchObject({
        status: "error",
        statusDetail: "rate limited",
      });
    });
  });

  it("rejects another plugin's connection, for both credentials and report", async () => {
    await withConnections(async ({ base }, registry, token) => {
      const theirs = await createConnectionOrFail(base, token, { type: "other/other-type" });
      const surface = readConnectionsSurface(registry.main);

      const decoded = await Effect.runPromise(Effect.flip(surface.credentials(theirs.id)));
      const reported = await Effect.runPromise(
        Effect.flip(surface.report(theirs.id, { status: "error" })),
      );

      expect(decoded).toMatchObject({ _tag: "ConnectionUnavailable" });
      expect(reported).toMatchObject({ _tag: "ConnectionUnavailable" });
    });
  });
});

describe("two plugins declaring the same type word", () => {
  /** A plugin as `GET /plugins` returns it; only the fields this test reads. */
  interface PluginRow {
    readonly id: string;
    readonly status: { readonly _tag: string; readonly message?: string };
    readonly contributions: ReadonlyArray<{ readonly id: string }>;
  }

  it("gives each plugin its own qualified type, and keeps each plugin's connections out of the other's reach", async () => {
    const first = buildConnectionPlugin({ id: "first", type: "gmail" });
    const second = buildConnectionPlugin({ id: "second", type: "gmail" });

    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        const response = await get(base, "/api/v1/plugins", token);
        expect(response.status, await response.clone().text()).toBe(200);
        const listed = (await response.json()) as ReadonlyArray<PluginRow>;
        const one = listed.find((plugin) => plugin.id === "first");
        const two = listed.find((plugin) => plugin.id === "second");

        expect(one?.status._tag).toBe("active");
        expect(two?.status._tag).toBe("active");
        expect(one?.contributions.map((contribution) => contribution.id)).toEqual(["first/gmail"]);
        expect(two?.contributions.map((contribution) => contribution.id)).toEqual(["second/gmail"]);

        const made = await createConnectionOrFail(base, token, { type: "first/gmail" });
        expect(made.type).toBe("first/gmail");

        const mine = await Effect.runPromise(readConnectionsSurface(first).list());
        const theirs = await Effect.runPromise(readConnectionsSurface(second).list());
        expect(mine.map((connection) => connection.id)).toEqual([made.id]);
        expect(theirs).toEqual([]);
      },
      { plugins: [first.plugin, second.plugin] },
    );
  });

  it("rejects a type word containing the / separator, so a qualified type has only one reading", async () => {
    const sneaky = buildConnectionPlugin({ id: "sneaky", type: "other/gmail" });

    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        const listed = (await (
          await get(base, "/api/v1/plugins", token)
        ).json()) as ReadonlyArray<PluginRow>;
        const refused = listed.find((plugin) => plugin.id === "sneaky");

        expect(refused?.status._tag).toBe("errored");
        expect(refused?.status.message).toContain("/");
        expect(refused?.contributions).toEqual([]);
      },
      { plugins: [sneaky.plugin] },
    );
  });
});
