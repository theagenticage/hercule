/**
 * The register pass of `PluginHost.boot`, seen through `Plugins.query` and
 * `Plugins.read`: what the catalog holds after a boot, what a second boot on
 * the same database does to it, and what a plugin that cannot be loaded or
 * whose `register` fails leaves behind. Nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  HOST_API,
  registerConnectionType,
  secret,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { PluginHost, Plugins } from "./index";
import { pluginRepository } from "./repository";
import { asUser, fixture, pluginStack, providerDefinition } from "./testing";

/** Every call runs on a stack of its own, as the user a request would arrive as. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost | SqlClient.SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(pluginStack()), asUser));

const detailOf = <T extends { readonly id: string }>(details: ReadonlyArray<T>, id: string) =>
  details.find((detail) => detail.id === id);

describe("PluginHost.boot on an empty database", () => {
  it("lists every registry plugin enabled, unconfigured, with its one contribution", async () => {
    const alpha = fixture({
      id: "alpha",
      definitions: [providerDefinition("alpha-provider", { model: "alpha-default" })],
    });
    const beta = fixture({
      id: "beta",
      definitions: [providerDefinition("beta-provider", { model: "beta-default" })],
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
      const detail = detailOf(details, id);
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
    const alpha = fixture({ id: "alpha" });
    const beta = fixture({ id: "beta" });

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
    expect(detailOf(details.listed, "beta")?.contributions).toHaveLength(1);
    expect(details.catalog.get("alpha")).toBeUndefined();
  });

  it("keeps a plugin disabled between boots", async () => {
    const alpha = fixture({ id: "alpha" });
    const beta = fixture({ id: "beta" });

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

    expect(detailOf(details, "alpha")?.enabled).toBe(false);
    expect(detailOf(details, "beta")?.enabled).toBe(true);
  });
});

describe("a plugin built against another host API version", () => {
  it("is refused with the two versions, never registered, and has no contributions", async () => {
    const future = fixture({ id: "future", hostApi: HOST_API + 1 });

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
  it("is refused for an unimplemented capability and for an unrenderable config schema", async () => {
    const channels = fixture({ id: "channels-plugin", capabilities: ["channels"] });
    const nested = fixture({
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
    const broken = fixture({ id: "broken", registerFails: "the harness binary is missing" });

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

  it("is errored naming the path when a contribution carries a function", async () => {
    const definition = {
      ...providerDefinition("callback-provider", {}),
      defaultConfig: { onStart: () => undefined } as unknown as Schema.Json,
    };
    const callback = fixture({ id: "callback", definitions: [definition] });

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
    const twice = fixture({
      id: "twice",
      definitions: [providerDefinition("same", {}), providerDefinition("same", {})],
    });
    const other = fixture({ id: "other" });

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
    expect(detailOf(details, "twice")?.contributions).toEqual([]);
    expect(detailOf(details, "other")?.contributions).toHaveLength(1);
  });

  it("is errored when its provider carries a config schema no form can render", async () => {
    const unrenderable = fixture({
      id: "unrenderable",
      definitions: [
        {
          ...providerDefinition("deep-provider", {}),
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

  it("is errored when its provider's display name overruns what an instance name takes", async () => {
    const shouty = fixture({
      id: "shouty",
      definitions: [{ ...providerDefinition("shouty-provider", {}), displayName: "S".repeat(129) }],
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

  it("is errored when its contribution carries a key the host does not know", async () => {
    const extra = fixture({
      id: "extra",
      definitions: [
        {
          ...providerDefinition("extra-provider", {}),
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
    const thrower = fixture({
      id: "thrower",
      register: () => {
        throw new Error("no such directory");
      },
    });
    const other = fixture({ id: "other" });

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
    expect(detailOf(details, "other")?.contributions).toHaveLength(1);
  });

  it("is errored when the Effect it returns dies", async () => {
    const dying = fixture({
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
  it("fails the boot naming the id, because the two would share every namespace", async () => {
    const first = fixture({ id: "doubled" });
    const second = fixture({ id: "doubled" });

    const crash = await run(
      Effect.flatMap(PluginHost, (host) => host.boot([first.plugin, second.plugin])).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("doubled");
  });
});

describe("a registry plugin whose manifest does not decode", () => {
  it("fails the boot saying what is wrong, because the registry is a file in this binary", async () => {
    const wrong = fixture({ id: "fine" });
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

describe("Plugins.read on an id no plugin carries", () => {
  it("is not_found", async () => {
    const only = fixture({ id: "only" });

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
 * A secret-valued field. It is entered per provider instance and stored under
 * that instance's own owner, so the two other places a plugin may declare a
 * config schema have nowhere to put one. Both are refused at registration,
 * where the author reads the reason, rather than rendering a form whose value
 * nothing would store.
 */
describe("a secret-valued field declared outside a provider", () => {
  it("refuses it in the plugin's own config, saying where one belongs", async () => {
    const keyed = fixture({
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

  it("refuses it in a connection type, naming the type", async () => {
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
          validate: () => Effect.succeed({ displayName: "Vault" }),
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
