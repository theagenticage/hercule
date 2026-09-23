/**
 * The connection routes over a real socket, and the runtime surface a plugin is
 * activated with, driven through the same controller a request meets.
 *
 * The registry is a pair of test plugins rather than the shipped one: a
 * connection type is a plugin contribution, so what these tests need is a type
 * whose `validate` answers on demand and a second plugin to be kept out of.
 *
 * The claim every create makes is the one a leak would break: the token that
 * went in is searched for in every response body.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type ActivationContext,
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

/** A connection as the API hands it back. */
interface ConnectionRecord {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly displayName: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, unknown>;
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly rotatedAt?: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The error envelope, as every failing operation answers with it. */
interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: { readonly issues?: ReadonlyArray<{ path: ReadonlyArray<string> }> };
  };
}

/** What the test type says when it turns a token down, in its own words. */
const REJECTED = "that token is not one this account knows";

/** The tokens the test type accepts, and one it does not. */
const GOOD = "good-1";
const ROTATED = "good-2";
const BAD = "nope-1";

/** An id of the right shape that nothing was ever created under. */
const ABSENT = "0198e4b0-0000-7000-8000-0000000000ff";

/** A plugin and the activation contexts the host handed it. */
interface TestPlugin {
  readonly plugin: Plugin;
  readonly contexts: Array<ActivationContext>;
}

/**
 * One plugin owning one connection type. `validate` accepts a `good-` token and
 * names the account after it, which is the whole of what the routes need from a
 * type: a yes, a no, and a display name that came from outside.
 *
 * `type` is the bare word the plugin declares. What every request below names
 * is the qualified `<pluginId>/<word>` the host mints from it.
 */
const buildConnectionPlugin = (options: {
  readonly id: string;
  readonly type: string;
  readonly flow?: "credentials" | "oauth";
  readonly configSchema?: Schema.Top;
}): TestPlugin => {
  const contexts: Array<ActivationContext> = [];
  const setup: ReadonlyArray<SetupStep> =
    options.flow === "oauth"
      ? [{ kind: "oauth" }]
      : [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }];

  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: HOST_API,
      capabilities: ["connections"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
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
            ? Effect.succeed({ displayName: `acct:${token}` })
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
const buildPlugins = () => ({
  main: buildConnectionPlugin({ id: "main", type: "main-type" }),
  other: buildConnectionPlugin({ id: "other", type: "other-type" }),
  configured: buildConnectionPlugin({
    id: "configured",
    type: "configured-type",
    configSchema: Schema.Struct({ watch: Schema.String }),
  }),
  oauth: buildConnectionPlugin({ id: "oauthy", type: "oauth-type", flow: "oauth" }),
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

/** Creates and asserts it worked, for the tests whose subject is something else. */
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

/** The runtime surface the host handed a plugin at its last activation. */
const readConnectionsSurface = (of: TestPlugin) => {
  const ctx = of.contexts.at(-1);
  if (ctx === undefined) throw new Error("the plugin was never activated");
  if (ctx.connections === undefined) throw new Error("the plugin was given no connections surface");
  return ctx.connections;
};

describe("POST /connections", () => {
  it("creates a connected connection from the type's own verdict, and puts no value on the wire", async () => {
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
        displayName: `acct:${GOOD}`,
        status: "connected",
        labels: ["Code"],
        config: {},
        credentials: [{ name: "token" }],
      });
      expect(record.id).toEqual(expect.any(String));
      expect(record.createdAt).toEqual(expect.any(String));
      expect(record.updatedAt).toEqual(expect.any(String));
      // The display name is derived from the token, so the body says the token
      // in the one place it may: nowhere else, under no other key.
      expect(text.split(`acct:${GOOD}`).join("")).not.toContain(GOOD);

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

  it("hands back the type's own message at the field, and writes nothing, when the token is turned down", async () => {
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

  it("refuses an unknown type, a missing declared field and an empty topic list", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const bodies = [
        { type: "nobody-type", label: "work", labels: ["Code"], credentials: { token: GOOD } },
        { type: "main/main-type", label: "work", labels: ["Code"], credentials: {} },
        { type: "main/main-type", label: "work", labels: [], credentials: { token: GOOD } },
      ];

      for (const body of bodies) {
        const error = await readError(await createConnection(base, token, body));
        expect(error.code, JSON.stringify(body)).toBe("validation");
      }
    });
  });

  it("refuses a type whose setup is an OAuth flow, and says where to start one", async () => {
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
  it("filters by type and by status, and reads one back with references and no values", async () => {
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
      expect(text.split(`acct:${GOOD}`).join("")).not.toContain(GOOD);
    });
  });

  it("answers not_found for an id nobody created", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      // One connection first, so a 404 from a route that does not exist yet
      // cannot pass for a 404 about this id.
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

  it("changes what the user chose and leaves the account, the status and the credentials alone", async () => {
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

  it("refuses an empty topic list and a config the type's schema turns down", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, {
        type: "configured/configured-type",
        config: { watch: "a" },
      });

      expect(
        await readError(await patchConnection(base, token, one.id, { labels: [] })),
      ).toMatchObject({
        code: "validation",
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

  it("answers invalid_state for a row whose type no plugin in this build defines", async () => {
    await withConnections(async ({ base, sql }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      // A build that dropped the plugin that defined the type, arranged the one
      // way a running controller cannot reach: the row outlives the catalog.
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

  it("accepts an empty config, and nothing else, for a type that declared no schema", async () => {
    await withConnections(async ({ base }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });

      const empty = await patchConnection(base, token, one.id, { config: {} });
      expect(empty.status, await empty.clone().text()).toBe(200);

      const filled = await patchConnection(base, token, one.id, { config: { watch: "a" } });
      expect(await readError(filled)).toMatchObject({ code: "validation" });
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

  it("puts a connection that needed reauthenticating back to connected, under its own id", async () => {
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
        status: "connected",
        displayName: `acct:${ROTATED}`,
      });
      expect(after.credentials[0]?.name).toBe("token");
      expect(after.credentials[0]?.rotatedAt).toEqual(expect.any(String));
    });
  });

  it("leaves everything as it was when the type turns the new token down", async () => {
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
});

describe("DELETE /connections/:id", () => {
  it("takes the connection and every secret it owned with it", async () => {
    await withConnections(async ({ base, audit }, _registry, token) => {
      const one = await createConnectionOrFail(base, token, { type: "main/main-type" });
      const second = await send("PUT", base, `/api/v1/secrets/connection/${one.id}/extra`, {
        body: { value: "another-value" },
        token,
      });
      expect(second.status).toBe(200);

      const response = await del(base, `/api/v1/connections/${one.id}`, token);

      expect(response.status, await response.clone().text()).toBe(200);
      expect((await get(base, `/api/v1/connections/${one.id}`, token)).status).toBe(404);
      const secrets = await get(
        base,
        `/api/v1/secrets?ownerKind=connection&ownerId=${one.id}`,
        token,
      );
      expect(await secrets.json()).toEqual({ items: [] });

      const entries = await audit("connection.deleted");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });
});

describe("the connections surface a plugin is activated with", () => {
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

  it("decodes the credentials of its own connection, and reports a status the API reads back", async () => {
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

  it("refuses another plugin's connection, whichever way it is reached for", async () => {
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

describe("two plugins declaring one word", () => {
  /** A plugin as `GET /plugins` hands it back; only what this test reads. */
  interface PluginRow {
    readonly id: string;
    readonly status: { readonly _tag: string; readonly message?: string };
    readonly contributions: ReadonlyArray<{ readonly id: string }>;
  }

  it("gives each its own qualified type, and keeps the other's connections out of its reach", async () => {
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

  it("refuses a word holding the separator, so a qualified type always has one reading", async () => {
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
