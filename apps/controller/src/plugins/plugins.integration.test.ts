/**
 * Tests the plugin routes over a real socket. The controller boots a registry
 * of fixture plugins through the real host, so a request reads what a real
 * boot left behind.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { LiveMessage } from "@hercule/contract";
import { HOST_API, registerEventSource, type Plugin } from "@hercule/plugin-host";
import {
  collectMessages,
  completeSetup,
  expectHeld,
  get,
  onSocket,
  post,
  send,
  waitForLiveToSettle,
  fetchTicket,
  withServer,
  waitWithin,
  type ServerHarness,
} from "../http/testing";
import { registry as shipped } from "./registry";
import { createPluginFixture, buildProviderDefinition } from "./testing";

/** A plugin as the API returns it. */
interface PluginDetail {
  readonly id: string;
  readonly displayName: string;
  readonly hostApi: number;
  readonly capabilities: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly status: {
    readonly _tag: string;
    readonly message?: string;
    readonly reason?: { readonly kind: string; readonly message?: string };
  };
  readonly configSchema?: unknown;
  readonly config: unknown;
  readonly contributions: ReadonlyArray<{
    readonly extensionPoint: string;
    readonly id: string;
    readonly definition: Record<string, unknown>;
  }>;
}

/**
 * Builds the fixture registry. It is built fresh for each test, because a
 * fixture counts its activations, and a shared registry would give the second
 * test a plugin the first test had already brought back to health.
 */
const buildPlugins = (): ReadonlyArray<Plugin> =>
  [
    createPluginFixture({
      id: "alpha",
      configSchema: Schema.Struct({ model: Schema.optionalKey(Schema.String) }),
      definitions: [buildProviderDefinition("alpha-provider", { model: "alpha-provider-default" })],
    }),
    createPluginFixture({ id: "beta" }),
    createPluginFixture({ id: "outdated", hostApi: HOST_API + 1 }),
    createPluginFixture({ id: "greedy", capabilities: ["providers", "channels"] }),
    createPluginFixture({
      id: "unrenderable",
      configSchema: Schema.Struct({ nested: Schema.Struct({}) }),
    }),
    createPluginFixture({ id: "flaky", activateFailures: 1 }),
  ].map((built) => built.plugin);

/** The plugins that get the `refused` status in the three ways possible, before any of their code runs. */
const REFUSED = ["outdated", "greedy", "unrenderable"] as const;

const withPlugins = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
  withServer(body, { plugins: buildPlugins() });

const listPlugins = async (base: string, token: string): Promise<ReadonlyArray<PluginDetail>> => {
  const response = await get(base, "/api/v1/plugins", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<PluginDetail>;
};

const readPlugin = async (base: string, token: string, id: string): Promise<PluginDetail> => {
  const response = await get(base, `/api/v1/plugins/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as PluginDetail;
};

const movePlugin = (base: string, token: string, id: string, verb: string): Promise<Response> =>
  post(base, `/api/v1/plugins/${id}/${verb}`, {}, token);

const configurePlugin = (
  base: string,
  token: string,
  id: string,
  config: unknown,
): Promise<Response> =>
  send("PUT", base, `/api/v1/plugins/${id}/config`, { body: { config }, token });

/** The write routes and their audit kinds, for tests that cover all of them. */
const WRITES = [
  { verb: "enable", audit: "plugin.enabled" },
  { verb: "disable", audit: "plugin.disabled" },
  { verb: "retry", audit: "plugin.retried" },
  { verb: "reset-state", audit: "plugin.stateReset" },
] as const;

/** Reads the catalog rows from the database, keyed by owner and row id. */
const readPersistedDefinitions = async (
  sql: ServerHarness["sql"],
): Promise<ReadonlyMap<string, unknown>> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      sql<{
        readonly owner: string;
        readonly id: string;
        readonly definition: string;
      }>`SELECT owner, id, definition FROM plugin_contributions`,
    ),
  );
  return new Map(rows.map((row) => [`${row.owner}/${row.id}`, JSON.parse(row.definition)]));
};

describe("GET /plugins", () => {
  it("returns every compiled-in plugin in registry order, with its details", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);

      const plugins = await listPlugins(base, token);
      expect(plugins.map((plugin) => plugin.id)).toEqual([
        "alpha",
        "beta",
        "outdated",
        "greedy",
        "unrenderable",
        "flaky",
      ]);

      for (const field of [
        "id",
        "displayName",
        "hostApi",
        "capabilities",
        "enabled",
        "status",
        "config",
        "contributions",
      ]) {
        expect(Object.keys(plugins[0] ?? {}), `a listed plugin carries ${field}`).toContain(field);
      }

      expect(plugins[0]).toMatchObject({
        id: "alpha",
        displayName: "Plugin alpha",
        hostApi: HOST_API,
        capabilities: ["providers"],
        enabled: true,
        status: { _tag: "active" },
        config: {},
      });
      expect(plugins[2]).toMatchObject({
        id: "outdated",
        status: {
          _tag: "refused",
          reason: { kind: "hostApi", expected: HOST_API, actual: HOST_API + 1 },
        },
      });
      expect(plugins[3]).toMatchObject({
        id: "greedy",
        status: {
          _tag: "refused",
          reason: { kind: "unimplementedCapability", capability: "channels" },
        },
      });
      const unrenderable = plugins[4]?.status;
      expect(unrenderable?._tag).toBe("refused");
      expect(unrenderable?.reason?.kind).toBe("unsupportedConfigSchema");
      expect((unrenderable?.reason?.message ?? "").length).toBeGreaterThan(0);
      expect(plugins[5]).toMatchObject({
        id: "flaky",
        status: { _tag: "errored", message: "flaky could not start" },
      });
    });
  });

  it("includes the plugin's config schema as JSON Schema", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);
      const plugins = await listPlugins(base, token);

      expect(plugins[0]?.configSchema).toEqual({
        type: "object",
        properties: { model: { type: "string" } },
        additionalProperties: false,
      });
      expect(plugins[1]?.configSchema).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
    });
  });

  it("includes each contribution as the catalog stored it", async () => {
    await withPlugins(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const plugins = await listPlugins(base, token);
      const stored = await readPersistedDefinitions(sql);

      const alpha = plugins[0]!;
      expect(alpha.contributions).toHaveLength(1);
      const contribution = alpha.contributions[0]!;
      expect(contribution.extensionPoint).toBe("provider");
      expect(contribution.id).toBe("alpha-provider");
      expect(contribution.definition).toEqual(stored.get("alpha/alpha-provider"));
      expect(contribution.definition).toMatchObject({
        id: "alpha-provider",
        displayName: "Provider alpha-provider",
        supportsMultipleInstances: true,
        defaultConfig: { model: "alpha-provider-default" },
      });

      for (const refused of REFUSED) {
        const plugin = plugins.find((one) => one.id === refused);
        expect(plugin?.contributions, refused).toEqual([]);
        expect(plugin, refused).not.toHaveProperty("configSchema");
      }
    });
  });
});

describe("GET /plugins/{id}", () => {
  it("returns the same plugin as the listing", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);
      const plugins = await listPlugins(base, token);

      for (const listed of plugins) {
        expect(await readPlugin(base, token, listed.id)).toEqual(listed);
      }
    });
  });

  it("fails with not_found for a plugin this binary does not include", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);
      // The same request for an installed plugin succeeds, so the error below
      // is about the id and not about the route.
      expect((await get(base, "/api/v1/plugins/alpha", token)).status).toBe(200);

      const response = await get(base, "/api/v1/plugins/gamma", token);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("the plugin routes with no credential", () => {
  it("returns 401 for every route, and changes nothing", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);

      const responses = [
        await send("GET", base, "/api/v1/plugins"),
        await send("GET", base, "/api/v1/plugins/alpha"),
        await send("POST", base, "/api/v1/plugins/alpha/enable", { body: {} }),
        await send("POST", base, "/api/v1/plugins/alpha/disable", { body: {} }),
        await send("POST", base, "/api/v1/plugins/flaky/retry", { body: {} }),
        await send("POST", base, "/api/v1/plugins/alpha/reset-state", { body: {} }),
        await send("PUT", base, "/api/v1/plugins/alpha/config", {
          body: { config: { model: "sonnet" } },
        }),
      ];

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
      }

      expect(await readPlugin(base, token, "alpha")).toMatchObject({
        enabled: true,
        status: { _tag: "active" },
        config: {},
      });
    });
  });
});

describe("the five lifecycle changes a user makes from Settings", () => {
  it("each returns the plugin as the change left it", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);

      const disabled = await movePlugin(base, token, "alpha", "disable");
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      expect(await disabled.json()).toMatchObject({
        id: "alpha",
        enabled: false,
        status: { _tag: "inactive" },
      });

      const enabled = await movePlugin(base, token, "alpha", "enable");
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        id: "alpha",
        enabled: true,
        status: { _tag: "active" },
      });

      const configured = await configurePlugin(base, token, "alpha", { model: "sonnet" });
      expect(configured.status, await configured.clone().text()).toBe(200);
      expect(await configured.json()).toMatchObject({
        id: "alpha",
        config: { model: "sonnet" },
        status: { _tag: "active" },
      });

      const reset = await movePlugin(base, token, "alpha", "reset-state");
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({
        id: "alpha",
        config: { model: "sonnet" },
        status: { _tag: "active" },
      });

      const retried = await movePlugin(base, token, "flaky", "retry");
      expect(retried.status, await retried.clone().text()).toBe(200);
      expect(await retried.json()).toMatchObject({ id: "flaky", status: { _tag: "active" } });
    });
  });

  it("each appends its own audit row, with the user as the actor", async () => {
    await withPlugins(async ({ base, audit }) => {
      const token = await completeSetup(base);

      expect((await movePlugin(base, token, "alpha", "disable")).status).toBe(200);
      expect((await movePlugin(base, token, "alpha", "enable")).status).toBe(200);
      expect((await movePlugin(base, token, "alpha", "reset-state")).status).toBe(200);
      expect((await configurePlugin(base, token, "alpha", { model: "sonnet" })).status).toBe(200);
      expect((await movePlugin(base, token, "flaky", "retry")).status).toBe(200);

      for (const kind of [
        "plugin.disabled",
        "plugin.enabled",
        "plugin.stateReset",
        "plugin.configured",
        "plugin.retried",
      ] as const) {
        const rows = await audit(kind);
        expect(rows, kind).toHaveLength(1);
        expect(rows[0]?.actor, kind).toBe("user");
      }
    });
  });
});

describe("what a live subscriber receives about a plugin", () => {
  it("names the plugin once per lifecycle change, whichever of the five it was", async () => {
    await withPlugins(async (harness) => {
      const token = await completeSetup(harness.base);
      // The activation failure during boot is also a plugin change, and it
      // may still be in flight when the listener starts.
      await waitForLiveToSettle();
      const ticket = await fetchTicket(harness.base, token);

      const moves: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
        ["alpha", () => movePlugin(harness.base, token, "alpha", "disable")],
        ["alpha", () => movePlugin(harness.base, token, "alpha", "enable")],
        ["alpha", () => configurePlugin(harness.base, token, "alpha", { model: "sonnet" })],
        ["alpha", () => movePlugin(harness.base, token, "alpha", "reset-state")],
        ["flaky", () => movePlugin(harness.base, token, "flaky", "retry")],
      ];

      let seen: ReadonlyArray<LiveMessage> = [];
      await onSocket(harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const plugins = yield* collectMessages(client, { topic: "plugin" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "plugin"));

          // One subscription for all five changes, and each message is awaited
          // before the next change is made. Changes are collected for a short
          // window before they are sent, so two changes made back to back
          // would arrive as one message naming both plugins.
          for (const [index, [id, makeMove]] of moves.entries()) {
            const response = yield* Effect.promise(makeMove);
            expect(response.status, `${id}: ${yield* Effect.promise(() => response.text())}`).toBe(
              200,
            );
            const arrived = yield* Effect.promise(() =>
              waitWithin(2000, () => plugins.received.length > index),
            );
            expect(arrived, id).toBe(true);
          }

          seen = plugins.received;
          yield* Fiber.interrupt(plugins.fiber);
        }),
      );

      expect(seen).toHaveLength(moves.length);
      expect(seen.map((message) => (message as { ids: ReadonlyArray<string> }).ids)).toEqual(
        moves.map(([id]) => [id]),
      );
      for (const message of seen) {
        expect(message._tag).toBe("invalidate");
      }
    });
  });
});

describe("a lifecycle change the plugin's state does not allow", () => {
  it("rejects a config the plugin's schema rejects, naming the field", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await configurePlugin(base, token, "alpha", { model: 42 });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        readonly error: {
          readonly code: string;
          readonly details: {
            readonly issues: ReadonlyArray<{
              readonly path: ReadonlyArray<string>;
              readonly message: string;
            }>;
          };
        };
      };
      expect(body.error.code).toBe("validation");
      expect(body.error.details.issues[0]?.path).toEqual(["model"]);
      expect(body.error.details.issues[0]?.message.length).toBeGreaterThan(0);

      expect(await readPlugin(base, token, "alpha")).toMatchObject({
        config: {},
        status: { _tag: "active" },
      });
    });
  });

  it("rejects a config with a key the plugin does not declare", async () => {
    await withPlugins(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await configurePlugin(base, token, "alpha", {
        model: "sonnet",
        colour: "red",
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect(await readPlugin(base, token, "alpha")).toMatchObject({ config: {} });
    });
  });

  it("rejects a retry of a plugin that is running, so Retry never works as a second Enable", async () => {
    await withPlugins(async ({ base, audit }) => {
      const token = await completeSetup(base);

      const response = await movePlugin(base, token, "alpha", "retry");
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect(await audit("plugin.retried")).toHaveLength(0);
    });
  });

  it("rejects every write on a refused plugin, whatever the reason it was refused", async () => {
    await withPlugins(async ({ base, audit }) => {
      const token = await completeSetup(base);

      for (const id of REFUSED) {
        for (const { verb } of WRITES) {
          const response = await movePlugin(base, token, id, verb);
          expect(response.status, `${id} ${verb}`).toBe(400);
          expect(await response.json(), `${id} ${verb}`).toMatchObject({
            error: { code: "validation" },
          });
        }

        const configured = await configurePlugin(base, token, id, {});
        expect(configured.status, id).toBe(400);
        expect(await configured.json(), id).toMatchObject({ error: { code: "validation" } });
      }

      for (const { audit: kind } of WRITES) {
        expect(await audit(kind), kind).toHaveLength(0);
      }
      expect(await audit("plugin.configured")).toHaveLength(0);
    });
  });
});

/**
 * Tests the registry a release ships, over the same routes. The tests above
 * boot a registry of fixtures; these boot the real registry, because they
 * check that a shipped plugin arrives complete.
 */
describe("the shipped registry over the routes", () => {
  it("includes the github plugin with its connections capability and its connection type", async () => {
    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        const found = (await listPlugins(base, token)).find((plugin) => plugin.id === "github");

        expect(found).toBeDefined();
        expect(found?.capabilities).toContain("connections");
        const contribution = found?.contributions.find(
          (one) => one.extensionPoint === "connection-type",
        );
        expect(contribution?.id).toBe("github/github");
        expect(contribution?.definition).toMatchObject({ displayName: "GitHub" });
      },
      { plugins: shipped },
    );
  });

  it("loads a plugin whose manifest asks for connections, rather than refusing it", async () => {
    const asking = createPluginFixture({
      id: "asking",
      capabilities: ["providers", "connections"],
    });

    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        expect(await readPlugin(base, token, "asking")).toMatchObject({
          capabilities: ["providers", "connections"],
          status: { _tag: "active" },
        });
      },
      { plugins: [asking.plugin] },
    );
  });
});

/**
 * Tests the event kind catalog that an emit is validated against. It is an
 * ordinary contribution, so these tests check the row a boot writes and what
 * a second boot does to it, read both from the table and through the route.
 */

/**
 * The event kinds the GitHub plugin declares, written out because the list
 * itself is what is tested. Spec 08 section 5.1 owns the list.
 */
const GITHUB_KINDS = [
  "github.notification",
  "github.issue.opened",
  "github.issue.closed",
  "github.issue.reopened",
  "github.issue.labeled",
  "github.issue.assigned",
  "github.issue.commented",
  "github.pr.opened",
  "github.pr.synchronized",
  "github.pr.review-submitted",
  "github.pr.commented",
  "github.pr.merged",
  "github.pr.closed",
  "github.pr.labeled",
  "github.pr.checks-completed",
] as const;

/** The subject block every payload has, so a ref and a URL are derived the same way. */
const SUBJECT_FIELDS = ["repo", "number", "title", "author", "state", "url"] as const;

interface ContributionRow {
  readonly owner: string;
  readonly extension_point: string;
  readonly id: string;
  readonly definition: string;
}

const readContributionRows = (
  sql: ServerHarness["sql"],
  extensionPoint: string,
): Promise<ReadonlyArray<ContributionRow>> =>
  Effect.runPromise(
    Effect.orDie(
      sql<ContributionRow>`
        SELECT owner, extension_point, id, definition FROM plugin_contributions
        WHERE extension_point = ${extensionPoint} ORDER BY owner, id
      `,
    ),
  );

type JsonSchema = Record<string, unknown>;

/**
 * Returns a JSON Schema node, following a `$ref` into the document's own
 * definitions. A schema shared by fifteen kinds is written once and referred
 * to, so a test that read only the inline form would test the derivation
 * rather than the block.
 */
const followRef = (node: unknown, root: JsonSchema): JsonSchema => {
  const schema = (node ?? {}) as JsonSchema;
  const ref = schema["$ref"];
  if (typeof ref !== "string") return schema;
  const name = ref.split("/").at(-1) ?? "";
  const defs = (root["$defs"] ?? root["definitions"] ?? {}) as Record<string, JsonSchema>;
  return defs[name] ?? {};
};

/** Builds a plugin that contributes one event source, for the registration tests. */
const buildEventSourcePlugin = (kinds: ReadonlyArray<string>): Plugin => ({
  manifest: {
    id: "acme",
    displayName: "Plugin acme",
    hostApi: HOST_API,
    capabilities: ["event-sources"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerEventSource(host, {
      id: "acme",
      connectionType: "acme/acme",
      kinds: Object.fromEntries(
        kinds.map((kind) => [
          kind,
          {
            description: `Something happened: ${kind}`,
            schema: Schema.Struct({
              subject: Schema.Struct({ repo: Schema.String, url: Schema.String }),
            }),
          },
        ]),
      ),
    }),
  activate: () => Effect.succeed(Effect.void),
});

describe("the event kinds the shipped github plugin declares", () => {
  it("writes one event-source row with the connection type and every event kind", async () => {
    await withServer(
      async ({ base, sql }) => {
        const token = await completeSetup(base);

        const rows = await readContributionRows(sql, "event-source");
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.owner).toBe("github");
        expect(row.id).toBe("github/github");

        const definition = JSON.parse(row.definition) as {
          readonly connectionType: string;
          readonly kinds: Record<string, { description: string; schema: JsonSchema }>;
        };
        expect(definition.connectionType).toBe("github/github");
        expect(Object.keys(definition.kinds).sort()).toEqual([...GITHUB_KINDS].sort());

        // The same row, through the route a client reads the catalog with.
        const found = (await listPlugins(base, token)).find((plugin) => plugin.id === "github");
        const contribution = found?.contributions.find(
          (one) => one.extensionPoint === "event-source",
        );
        expect(contribution?.id).toBe("github/github");
        expect(contribution?.definition).toEqual(definition);
      },
      { plugins: shipped },
    );
  });

  it("declares each kind with a description and a payload schema that includes the subject", async () => {
    await withServer(
      async ({ sql }) => {
        const rows = await readContributionRows(sql, "event-source");
        const definition = JSON.parse(rows[0]!.definition) as {
          readonly kinds: Record<string, { description: string; schema: JsonSchema }>;
        };

        for (const kind of GITHUB_KINDS) {
          const declared = definition.kinds[kind];
          expect(declared, kind).toBeDefined();
          expect((declared?.description ?? "").length, kind).toBeGreaterThan(0);

          const schema = declared!.schema;
          expect(schema["type"], kind).toBe("object");
          const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
          const subject = followRef(properties["subject"], schema);
          expect(subject["type"], `${kind} subject`).toBe("object");
          expect(
            Object.keys((subject["properties"] ?? {}) as Record<string, unknown>),
            `${kind} subject`,
          ).toEqual(expect.arrayContaining([...SUBJECT_FIELDS]));
        }
      },
      { plugins: shipped },
    );
  });

  it("leaves the same row when the controller boots a second time", async () => {
    await withServer(
      async ({ sql, reboot }) => {
        const before = await readContributionRows(sql, "event-source");
        expect(before).toHaveLength(1);

        await reboot();

        expect(await readContributionRows(sql, "event-source")).toEqual(before);
      },
      { plugins: shipped },
    );
  });
});

describe("an event source whose kind is not namespaced", () => {
  it("marks the plugin errored, naming the kind, and writes no row", async () => {
    await withServer(
      async ({ base, sql }) => {
        const token = await completeSetup(base);

        const plugin = await readPlugin(base, token, "acme");
        expect(plugin.status._tag).toBe("errored");
        expect(plugin.status.message ?? "").toContain("thing.happened");
        expect(plugin.contributions).toEqual([]);
        expect(await readContributionRows(sql, "event-source")).toEqual([]);
      },
      { plugins: [buildEventSourcePlugin(["thing.happened"])] },
    );
  });

  it("accepts the same kind once it starts with the plugin id", async () => {
    await withServer(
      async ({ base, sql }) => {
        const token = await completeSetup(base);

        expect(await readPlugin(base, token, "acme")).toMatchObject({ status: { _tag: "active" } });
        const rows = await readContributionRows(sql, "event-source");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe("acme/acme");
        const definition = JSON.parse(rows[0]!.definition) as {
          readonly kinds: Record<string, unknown>;
        };
        expect(Object.keys(definition.kinds)).toEqual(["acme.thing.happened"]);
      },
      { plugins: [buildEventSourcePlugin(["acme.thing.happened"])] },
    );
  });
});
