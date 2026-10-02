/**
 * Tests the registration pass of `PluginHost.boot`, through `Plugins.query`
 * and `Plugins.read`:
 *
 * - what the catalog holds after a boot;
 * - what a second boot on the same database changes;
 * - what a plugin that cannot be loaded, or whose `register` fails, leaves
 *   behind.
 *
 * Nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  secret,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { PluginHost, Plugins } from "./index";
import { pluginRepository } from "./repository";
import {
  asUser,
  buildActionPlugin,
  createPluginFixture,
  NOTE_APPEND_ACTION,
  notesPlugin,
  buildPluginStack,
  buildProviderDefinition,
} from "./testing";

/** Runs an effect on a fresh plugin stack, as the user, like a request through the API. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost | SqlClient.SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(buildPluginStack()), asUser));

const findDetail = <T extends { readonly id: string }>(details: ReadonlyArray<T>, id: string) =>
  details.find((detail) => detail.id === id);

describe("PluginHost.boot on an empty database", () => {
  it("lists every registry plugin enabled, unconfigured, with its one contribution", async () => {
    const alpha = createPluginFixture({
      id: "alpha",
      definitions: [buildProviderDefinition("alpha-provider", { model: "alpha-default" })],
    });
    const beta = createPluginFixture({
      id: "beta",
      definitions: [buildProviderDefinition("beta-provider", { model: "beta-default" })],
    });

    const details = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([alpha.plugin, beta.plugin]));
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );

    expect(details.map((detail) => detail.id)).toEqual(["alpha", "beta"]);

    for (const [id, model] of [
      ["alpha", "alpha-default"],
      ["beta", "beta-default"],
    ] as const) {
      const detail = findDetail(details, id);
      expect(detail?.enabled).toBe(true);
      expect(detail?.config).toEqual({});
      expect(detail?.contributions).toHaveLength(1);
      const contribution = detail?.contributions[0];
      expect(contribution?.extensionPoint).toBe("provider");
      expect(contribution?.id).toBe(`${id}-provider`);
      const definition = contribution?.definition as {
        readonly configSchema: unknown;
        readonly defaultConfig: unknown;
      };
      expect(definition.configSchema).toMatchObject({
        type: "object",
        properties: { token: { type: "string" } },
      });
      expect(definition.defaultConfig).toEqual({ model });
    }
  });
});

describe("a second PluginHost.boot on the same database", () => {
  it("lists only the plugins still in the registry, each contribution once", async () => {
    const alpha = createPluginFixture({ id: "alpha" });
    const beta = createPluginFixture({ id: "beta" });

    const details = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* host.boot([beta.plugin]);
        const repository = yield* pluginRepository;
        return {
          listed: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
          catalog: yield* repository.contributions(),
        };
      }),
    );

    expect(details.listed.map((detail) => detail.id)).toEqual(["beta"]);
    expect(findDetail(details.listed, "beta")?.contributions).toHaveLength(1);
    expect(details.catalog.get("alpha")).toBeUndefined();
  });

  it("keeps a plugin disabled between boots", async () => {
    const alpha = createPluginFixture({ id: "alpha" });
    const beta = createPluginFixture({ id: "beta" });

    const details = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE plugins SET enabled = 0 WHERE id = 'alpha'`;
        yield* host.boot([alpha.plugin, beta.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );

    expect(findDetail(details, "alpha")?.enabled).toBe(false);
    expect(findDetail(details, "beta")?.enabled).toBe(true);
  });
});

describe("a plugin built against another host API version", () => {
  it("gets the refused status with both versions, is never registered, and has no contributions", async () => {
    const future = createPluginFixture({ id: "future", hostApi: HOST_API + 1 });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([future.plugin]);
        return {
          status: yield* host.status("future"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("future")),
        };
      }),
    );

    expect(future.hosts).toEqual([]);
    expect(Option.getOrNull(status)).toEqual({
      _tag: "refused",
      reason: { kind: "hostApi", expected: HOST_API, actual: HOST_API + 1 },
    });
    expect(detail.status).toEqual({
      _tag: "refused",
      reason: { kind: "hostApi", expected: HOST_API, actual: HOST_API + 1 },
    });
    expect(detail.contributions).toEqual([]);
  });
});

describe("a plugin the host cannot load", () => {
  it("gets the refused status for an unimplemented capability and for a config schema no form can render", async () => {
    const channels = createPluginFixture({ id: "channels-plugin", capabilities: ["channels"] });
    const nested = createPluginFixture({
      id: "nested-plugin",
      configSchema: Schema.Struct({ server: Schema.Struct({ host: Schema.String }) }),
    });

    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([channels.plugin, nested.plugin]);
        return {
          channels: yield* host.status("channels-plugin"),
          nested: yield* host.status("nested-plugin"),
        };
      }),
    );

    expect(Option.getOrNull(statuses.channels)).toEqual({
      _tag: "refused",
      reason: { kind: "unimplementedCapability", capability: "channels" },
    });

    const nestedStatus = Option.getOrNull(statuses.nested) as {
      readonly _tag: string;
      readonly reason: { readonly kind: string; readonly message: string };
    } | null;
    expect(nestedStatus?._tag).toBe("refused");
    expect(nestedStatus?.reason.kind).toBe("unsupportedConfigSchema");
    expect(nestedStatus?.reason.message.length).toBeGreaterThan(0);

    expect(channels.hosts).toEqual([]);
    expect(nested.hosts).toEqual([]);
  });
});

describe("a plugin whose register fails", () => {
  it("is errored with its own message, holds no contributions, and is never activated", async () => {
    const broken = createPluginFixture({
      id: "broken",
      registerFails: "the harness binary is missing",
    });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([broken.plugin]);
        return {
          status: yield* host.status("broken"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("broken")),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("the harness binary is missing");
    expect(detail.contributions).toEqual([]);
    expect(broken.calls).toEqual([]);
  });

  it("is errored, naming the path, when a contribution contains a function", async () => {
    const definition = {
      ...buildProviderDefinition("callback-provider", {}),
      defaultConfig: { onStart: () => undefined } as unknown as Schema.Json,
    };
    const callback = createPluginFixture({ id: "callback", definitions: [definition] });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([callback.plugin]);
        return {
          status: yield* host.status("callback"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("callback")),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("defaultConfig");
    expect(detail.contributions).toEqual([]);
    expect(callback.calls).toEqual([]);
  });

  it("is errored, keeping every other plugin's rows, when it registers one id twice", async () => {
    const twice = createPluginFixture({
      id: "twice",
      definitions: [buildProviderDefinition("same", {}), buildProviderDefinition("same", {})],
    });
    const other = createPluginFixture({ id: "other" });

    const { status, details } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([twice.plugin, other.plugin]);
        return {
          status: yield* host.status("twice"),
          details: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("provider");
    expect(errored?.message).toContain("same");
    expect(findDetail(details, "twice")?.contributions).toEqual([]);
    expect(findDetail(details, "other")?.contributions).toHaveLength(1);
  });

  it("is errored when its provider has a config schema no form can render", async () => {
    const unrenderable = createPluginFixture({
      id: "unrenderable",
      definitions: [
        {
          ...buildProviderDefinition("deep-provider", {}),
          configSchema: Schema.Struct({ server: Schema.Struct({ host: Schema.String }) }),
        },
      ],
    });

    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([unrenderable.plugin]);
        return yield* host.status("unrenderable");
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("deep-provider");
  });

  it("is errored when its provider's display name is longer than an instance name allows", async () => {
    const shouty = createPluginFixture({
      id: "shouty",
      definitions: [
        { ...buildProviderDefinition("shouty-provider", {}), displayName: "S".repeat(129) },
      ],
    });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([shouty.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("shouty"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    expect(detail.contributions).toEqual([]);
  });

  it("is errored when its contribution has a key the host does not know", async () => {
    const extra = createPluginFixture({
      id: "extra",
      definitions: [
        {
          ...buildProviderDefinition("extra-provider", {}),
          onStart: () => undefined,
        } as ProviderDefinition,
      ],
    });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([extra.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("extra"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    expect(detail.contributions).toEqual([]);
  });
});

describe("a plugin whose register crashes", () => {
  it("is errored when the hook throws before it returns an Effect", async () => {
    const thrower = createPluginFixture({
      id: "thrower",
      register: () => {
        throw new Error("no such directory");
      },
    });
    const other = createPluginFixture({ id: "other" });

    const { status, details } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([thrower.plugin, other.plugin]);
        return {
          status: yield* host.status("thrower"),
          details: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toBe("no such directory");
    expect(findDetail(details, "other")?.contributions).toHaveLength(1);
  });

  it("is errored when the Effect it returns dies", async () => {
    const dying = createPluginFixture({
      id: "dying",
      register: () => Effect.die(new Error("the manifest was generated wrong")),
    });

    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([dying.plugin]);
        return yield* host.status("dying");
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toBe("the manifest was generated wrong");
  });
});

describe("a registry that lists one plugin id twice", () => {
  it("fails the boot, naming the id, because the two would share every namespace", async () => {
    const first = createPluginFixture({ id: "doubled" });
    const second = createPluginFixture({ id: "doubled" });

    const crash = await run(
      Effect.flatMap(PluginHost, (host) => host.boot([first.plugin, second.plugin])).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("doubled");
  });
});

describe("a registry plugin whose manifest does not decode", () => {
  it("fails the boot with the decode error, because the registry is compiled into this binary", async () => {
    const wrong = createPluginFixture({ id: "fine" });
    const broken: Plugin = {
      ...wrong.plugin,
      manifest: { ...wrong.plugin.manifest, id: "Not A Slug" },
    };

    const crash = await run(
      Effect.flatMap(PluginHost, (host) => host.boot([broken])).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("id");
    expect(crash).toContain("Not A Slug");
  });
});

describe("Plugins.read on an unknown plugin id", () => {
  it("fails with not_found", async () => {
    const only = createPluginFixture({ id: "only" });

    const error = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([only.plugin]);
        return yield* Effect.flip(Effect.flatMap(Plugins, (plugins) => plugins.read("absent")));
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(error)).toContain("absent");
  });
});

/**
 * A secret field is entered per provider instance and stored under that
 * instance as its owner. The two other places a plugin can declare a config
 * schema have nowhere to store one. So both are rejected at registration,
 * where the author sees the reason, rather than showing a form whose value
 * nothing would store.
 */
describe("a secret field declared outside a provider", () => {
  it("gives the plugin the refused status when declared in its own config, and says where one belongs", async () => {
    const keyed = createPluginFixture({
      id: "keyed-plugin",
      configSchema: Schema.Struct({
        apiKey: secret({ title: "API key", description: "The vendor's own." }),
      }),
    });

    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([keyed.plugin]);
        return yield* host.status("keyed-plugin");
      }),
    );

    const refused = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly reason: { readonly kind: string; readonly message: string };
    } | null;
    expect(refused?._tag).toBe("refused");
    expect(refused?.reason.kind).toBe("unsupportedConfigSchema");
    expect(refused?.reason.message).toContain("provider definition only");
    expect(keyed.hosts).toEqual([]);
  });

  it("marks the plugin errored when declared in a connection type, naming the type", async () => {
    const plugin: Plugin = {
      manifest: {
        id: "keyed-connection",
        displayName: "Plugin keyed-connection",
        hostApi: HOST_API,
        capabilities: ["connections"],
        configSchema: Schema.Struct({}),
      },
      register: (host) =>
        registerConnectionType(host, {
          type: "vault",
          displayName: "Vault",
          setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
          configSchema: Schema.Struct({
            apiKey: secret({ title: "API key", description: "The vendor's own." }),
          }),
          validate: () => Effect.succeed({ displayName: "Vault", accountId: "vault-1" }),
        }),
      activate: () => Effect.succeed(Effect.void),
    };

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([plugin]);
        return {
          status: yield* host.status("keyed-connection"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("keyed-connection")),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("keyed-connection/vault");
    expect(errored?.message).toContain("provider definition only");
    expect(detail.contributions).toEqual([]);
  });
});

/**
 * An `oauth` or `device` step is a flow the setup screen offers, and its
 * declaration is where that flow sends the user and asks for tokens. One
 * without the other cannot work, so registration refuses the type and names
 * what is missing.
 */
describe("a connection type's token flows", () => {
  const OAUTH = {
    authorizationUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    scopes: [],
  };
  const DEVICE = {
    clientId: "client",
    deviceCodeUrl: "https://example.test/device/code",
    tokenUrl: "https://example.test/token",
    scopes: [],
  };

  /** Boots a plugin that registers one connection type with the given flow parts. */
  const bootWithType = (parts: Record<string, unknown>) => {
    const plugin: Plugin = {
      manifest: {
        id: "flows",
        displayName: "Plugin flows",
        hostApi: HOST_API,
        capabilities: ["connections"],
        configSchema: Schema.Struct({}),
      },
      register: (host) =>
        registerConnectionType(host, {
          type: "forge",
          displayName: "Forge",
          setup: [],
          validate: () => Effect.succeed({ displayName: "Forge", accountId: "forge-1" }),
          ...parts,
        }),
      activate: () => Effect.succeed(Effect.void),
    };
    return run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([plugin]);
        return yield* host.status("flows");
      }),
    );
  };

  it.each([
    [
      "an oauth step without its declaration",
      { setup: [{ kind: "oauth" }] },
      "the oauth step needs the oauth declaration",
    ],
    [
      "a device step without its declaration",
      { setup: [{ kind: "device" }] },
      "the device step needs the device declaration",
    ],
    [
      "a device declaration without its step",
      {
        setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Token" }] }],
        device: DEVICE,
      },
      "the device declaration needs a device step",
    ],
    [
      "both a redirect flow and a device flow",
      { setup: [{ kind: "oauth" }, { kind: "device" }], oauth: OAUTH, device: DEVICE },
      "not both",
    ],
    [
      "a pasted credential field named like the core's token set",
      { setup: [{ kind: "credentials", fields: [{ name: "oauth.tokens", label: "Tokens" }] }] },
      "the credential field name oauth.tokens is reserved",
    ],
  ])("refuses %s, naming the type", async (_, parts, reason) => {
    const message = readErroredMessage(await bootWithType(parts));

    expect(message).toContain("flows/forge");
    expect(message).toContain(reason);
  });

  it("accepts a device flow beside a pasted token", async () => {
    const status = await bootWithType({
      setup: [
        { kind: "device" },
        { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
      ],
      device: DEVICE,
    });

    expect(readErroredMessage(status)).toBeUndefined();
  });
});

/** Returns the message of an errored plugin, or `undefined` if the plugin is not errored. */
const readErroredMessage = (status: Option.Option<unknown>): string | undefined => {
  const found = Option.getOrNull(status) as { readonly _tag: string; readonly message?: string };
  return found._tag === "errored" ? found.message : undefined;
};

describe("the workflow action catalog", () => {
  it("has a row for each built-in action, owned by core, and one for each plugin action under its qualified id", async () => {
    const rows = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([notesPlugin]));
        const contributions = yield* Effect.flatMap(pluginRepository, (repository) =>
          repository.contributions(),
        );
        return [...contributions].flatMap(([owner, owned]) =>
          owned
            .filter((row) => row.extensionPoint === "workflow-action")
            .map((row) => `${owner} ${row.id}`),
        );
      }),
    );

    expect(rows.sort()).toEqual([
      "core git.commit",
      "core git.push",
      "core notification.create",
      "core run.start",
      "core task.create",
      "core task.query",
      "core task.update",
      "core wait",
      "notes notes/note.append",
    ]);
  });

  it("marks a plugin errored if its action id contains a / or its input schema is not a struct", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildActionPlugin("slashed", { ...NOTE_APPEND_ACTION, id: "note/append" }),
          buildActionPlugin("listed", {
            ...NOTE_APPEND_ACTION,
            input: Schema.Array(Schema.String),
          }),
        ]);
        return {
          slashed: yield* host.status("slashed"),
          listed: yield* host.status("listed"),
          actions: yield* host.listActiveWorkflowActions(),
        };
      }),
    );

    expect(readErroredMessage(statuses.slashed)).toContain("The id cannot contain a / character");
    expect(readErroredMessage(statuses.listed)).toContain("struct");
    expect(statuses.actions.map((action) => action.id)).toEqual([
      "git.commit",
      "git.push",
      "notification.create",
      "run.start",
      "task.create",
      "task.query",
      "task.update",
      "wait",
    ]);
  });
});

/** Builds a plugin that declares one event source, with the id `word`, and one event kind. */
const buildEventSourcePlugin = (id: string, word: string, kind: string): Plugin => ({
  manifest: {
    id,
    displayName: `Plugin ${id}`,
    hostApi: HOST_API,
    capabilities: ["event-sources"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerEventSource(host, {
      id: word,
      connectionType: `${id}/${id}`,
      kinds: {
        [kind]: {
          description: `Something happened: ${kind}`,
          schema: Schema.Struct({ url: Schema.String }),
        },
      },
    }),
  activate: () => Effect.succeed(Effect.void),
});

describe("the event source catalog", () => {
  it("marks a plugin errored if its event source id contains a /", async () => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([buildEventSourcePlugin("acme", "acme/feed", "acme.thing.done")]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain("The id cannot contain a / character");
  });

  it("marks a plugin errored if it declares a core event kind, and includes the kind in the message", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("task", "task", "task.created"),
          buildEventSourcePlugin("cron", "cron", "cron.tick"),
        ]);
        return [yield* host.status("task"), yield* host.status("cron")];
      }),
    );

    for (const [status, kind] of [
      [statuses[0]!, "task.created"],
      [statuses[1]!, "cron.tick"],
    ] as const) {
      const message = readErroredMessage(status);
      expect(message, kind).toContain(`the event kind ${kind} is already declared by the core`);
    }
  });
});

describe("a registry that lists a plugin with the id core", () => {
  it("fails the boot, because that id is reserved for the built-in contributions", async () => {
    const crash = await run(
      Effect.flatMap(PluginHost, (host) =>
        host.boot([createPluginFixture({ id: "core" }).plugin]),
      ).pipe(
        Effect.as("booted"),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("a plugin with the id core");
    expect(crash).toContain("Give the plugin another id.");
  });
});
