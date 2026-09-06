/**
 * What happens to a plugin after it has registered: the activation pass at the
 * end of a boot, the surfaces its hooks are handed, and the five moves a user
 * makes from Settings - enable, disable, configure, retry and reset state.
 *
 * The behaviour spans the host (which runs the hooks and holds the status) and
 * the operation service (which is how a user asks for a move), so both are
 * driven here rather than split across two files that would each see half of
 * every outcome.
 *
 * Fixture plugins are built here and record what they observed; nothing is
 * mocked. A fixture keeps the activation contexts it was handed, and the test
 * calls the capability surfaces on them the way the plugin's own code would.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Cause, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  HOST_API,
  PluginError,
  type ActivationContext,
  type KeyValueStore,
  type Plugin,
  type PluginCapability,
  type PluginSecrets,
  type ProviderDefinition,
  type RegistrationHost,
} from "@hydra/plugin-host";
import { CurrentActor, type Actor } from "../actor";
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { masterKeyLayer, Secret, SecretLayer, Secrets, secretsLayer } from "../secrets";
import { PluginHost, PluginHostLayer, Plugins, PluginsLayer } from "./index";

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/**
 * The real host and service over a `:memory:` database, the real secrets
 * repository and a master key file: a plugin's secrets are rows in the one
 * secrets table, so the encryption is part of what is under test.
 */
const stack = () => {
  const home = mkdtempSync(join(tmpdir(), "hydra-plugin-lifecycle-"));
  homes.push(home);
  return PluginsLayer.pipe(
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
  );
};

type Services = Plugins | PluginHost | Secret | Secrets | AuditLog | SqlClient.SqlClient;

/** Every call runs as the user actor, which is what a request through the API is. */
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(body.pipe(Effect.provide(stack()), Effect.provideService(CurrentActor, USER)));

/** One provider definition, the only contribution shape with a consumer. */
const providerDefinition = (id: string): ProviderDefinition => ({
  id,
  displayName: `Provider ${id}`,
  supportsMultipleInstances: true,
  configSchema: Schema.Struct({ token: Schema.String }),
  defaultConfig: {},
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
});

interface Fixture {
  readonly plugin: Plugin;
  /** `activate` and `deactivate`, in the order the plugin observed them. */
  readonly calls: Array<string>;
  /** Whether an instance the plugin started is still up. */
  running: () => boolean;
  /** The context of every `activate` call, in order. */
  readonly contexts: Array<ActivationContext>;
  /** The host of every `register` call, in order. */
  readonly hosts: Array<RegistrationHost>;
}

const fixture = (options: {
  readonly id: string;
  readonly capabilities?: ReadonlyArray<PluginCapability>;
  readonly configSchema?: Schema.Top;
  /** How many `activate` calls fail before the first one that succeeds. */
  readonly activateFailures?: number;
  /** The message the returned deactivate fails with, when it fails. */
  readonly deactivateFails?: string;
  /** The message `register` fails with, for a plugin that never gets that far. */
  readonly registerFails?: string;
  /** Whether the hooks yield, so a second caller can interleave with them. */
  readonly slow?: boolean;
}): Fixture => {
  const calls: Array<string> = [];
  const contexts: Array<ActivationContext> = [];
  const hosts: Array<RegistrationHost> = [];
  let remainingFailures = options.activateFailures ?? 0;
  let up = false;
  const pause = options.slow === true ? Effect.yieldNow : Effect.void;

  const plugin: Plugin = {
    manifest: {
      id: options.id,
      displayName: `Plugin ${options.id}`,
      hostApi: HOST_API,
      capabilities: options.capabilities ?? ["providers"],
      configSchema: options.configSchema ?? Schema.Struct({}),
    },
    register: (host) =>
      Effect.suspend(() => {
        hosts.push(host);
        if (options.registerFails !== undefined) {
          return Effect.fail(new PluginError({ message: options.registerFails }));
        }
        return host.providers === undefined
          ? Effect.void
          : host.providers.register(providerDefinition(`${options.id}-provider`));
      }),
    activate: (ctx) =>
      Effect.suspend(() => {
        calls.push("activate");
        contexts.push(ctx);
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          return Effect.fail(new PluginError({ message: `${options.id} could not start` }));
        }
        up = true;
        return Effect.as(
          pause,
          Effect.suspend(() => {
            calls.push("deactivate");
            if (options.deactivateFails !== undefined) {
              return Effect.fail(new PluginError({ message: options.deactivateFails }));
            }
            up = false;
            return pause;
          }),
        );
      }),
  };

  return { plugin, calls, contexts, hosts, running: () => up };
};

/** The context of the plugin's most recent activation: what it is running with. */
const currentContext = (of: Fixture): ActivationContext => {
  const ctx = of.contexts.at(-1);
  if (ctx === undefined) throw new Error(`${of.plugin.manifest.id} was never activated`);
  return ctx;
};

const kvOf = (of: Fixture): KeyValueStore => {
  const kv = currentContext(of).kv;
  if (kv === undefined) throw new Error(`${of.plugin.manifest.id} was given no kv surface`);
  return kv;
};

const secretsOf = (of: Fixture): PluginSecrets => {
  const secrets = currentContext(of).secrets;
  if (secrets === undefined) {
    throw new Error(`${of.plugin.manifest.id} was given no secrets surface`);
  }
  return secrets;
};

describe("what a plugin's hooks are handed", () => {
  it("gives register the providers surface only, whatever else the manifest asked for", async () => {
    const everything = fixture({ id: "everything", capabilities: ["providers", "kv", "secrets"] });

    await run(Effect.flatMap(PluginHost, (host) => host.boot([everything.plugin])));

    const host = everything.hosts[0] as RegistrationHost & {
      readonly kv?: unknown;
      readonly secrets?: unknown;
    };
    expect(host.providers).toBeDefined();
    // Registration surfaces only: a runtime one before the catalog exists would
    // let a plugin act on a system that is still half-loaded.
    expect(host.kv).toBeUndefined();
    expect(host.secrets).toBeUndefined();
  });

  it("gives activate exactly the runtime surfaces the manifest asked for", async () => {
    const bare = fixture({ id: "bare", capabilities: ["providers"] });
    const stateful = fixture({ id: "stateful", capabilities: ["providers", "kv"] });
    const trusted = fixture({ id: "trusted", capabilities: ["providers", "kv", "secrets"] });

    await run(
      Effect.flatMap(PluginHost, (host) =>
        host.boot([bare.plugin, stateful.plugin, trusted.plugin]),
      ),
    );

    expect(currentContext(bare).kv).toBeUndefined();
    expect(currentContext(bare).secrets).toBeUndefined();

    expect(currentContext(stateful).kv).toBeDefined();
    expect(currentContext(stateful).secrets).toBeUndefined();

    expect(currentContext(trusted).kv).toBeDefined();
    expect(currentContext(trusted).secrets).toBeDefined();
  });
});

/**
 * A row as an earlier boot left it, so this boot's activation pass is the first
 * one and finds a plugin the user already disabled or configured.
 */
const storedState = (id: string, enabled: 0 | 1, config: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO plugins (id, enabled, config, created_at, updated_at)
      VALUES (${id}, ${enabled}, ${config}, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')
    `,
  );

describe("the activation pass at the end of a boot", () => {
  it("activates each enabled plugin with its stored config, and leaves a disabled one alone", async () => {
    const enabled = fixture({
      id: "enabled",
      configSchema: Schema.Struct({
        model: Schema.String,
        retries: Schema.optionalKey(Schema.Finite),
      }),
    });
    const other = fixture({ id: "other" });
    const off = fixture({ id: "off" });

    await run(
      Effect.gen(function* () {
        yield* storedState("enabled", 1, '{"model":"opus"}');
        yield* storedState("off", 0, "{}");
        yield* Effect.flatMap(PluginHost, (host) =>
          host.boot([enabled.plugin, other.plugin, off.plugin]),
        );
      }),
    );

    expect(enabled.calls).toEqual(["activate"]);
    expect(other.calls).toEqual(["activate"]);
    expect(off.calls).toEqual([]);
    expect(currentContext(enabled).config).toEqual({ model: "opus" });
  });

  it("errors an enabled plugin whose stored config no longer decodes, and does not activate it", async () => {
    const drifted = fixture({
      id: "drifted",
      configSchema: Schema.Struct({ model: Schema.String }),
    });

    const detail = await run(
      Effect.gen(function* () {
        // What a plugin whose schema changed between two versions leaves behind.
        yield* storedState("drifted", 1, '{"model":42}');
        yield* Effect.flatMap(PluginHost, (host) => host.boot([drifted.plugin]));
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("drifted"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    // Field-level, so the user reads which setting is wrong rather than that
    // something is.
    expect((detail.status as { readonly message: string }).message).toContain("model");
    expect(drifted.calls).toEqual([]);
  });
});

describe("disabling and enabling a plugin", () => {
  it("deactivates it, marks it inactive, and marks its contributions as a disabled plugin's", async () => {
    const alpha = fixture({ id: "alpha" });
    const beta = fixture({ id: "beta" });

    const { detail, rows } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.disable("alpha")),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.disabled")),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate"]);
    expect(detail.status).toEqual({ _tag: "inactive" });
    expect(detail.enabled).toBe(false);
    // The rows stay, so the UI can still say what the plugin offers.
    expect(detail.contributions).toHaveLength(1);
    expect(detail.contributions[0]?.ownerEnabled).toBe(false);
    expect(beta.calls).toEqual(["activate"]);
  });

  it("activates it again when it is enabled", async () => {
    const alpha = fixture({ id: "alpha" });

    const { detail, rows } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        return {
          detail: yield* plugins.enable("alpha"),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.enabled")),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate"]);
    expect(detail.status).toEqual({ _tag: "active" });
    expect(detail.enabled).toBe(true);
    expect(detail.contributions[0]?.ownerEnabled).toBe(true);
  });
});

describe("configuring a plugin", () => {
  // The key is optional, so the plugin starts on the empty config it is
  // installed with and the test can then configure a running plugin.
  const configurable = (id: string) =>
    fixture({ id, configSchema: Schema.Struct({ model: Schema.optionalKey(Schema.String) }) });

  it("restarts it with the new config, and stores what it was restarted with", async () => {
    const alpha = configurable("alpha");

    const { detail, rows } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) =>
            plugins.configure("alpha", { config: { model: "sonnet" } }),
          ),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.configured")),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    // A plugin never observes a config change while running: it is stopped,
    // then started again with the new one.
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate"]);
    expect(currentContext(alpha).config).toEqual({ model: "sonnet" });
    expect(detail.config).toEqual({ model: "sonnet" });
  });

  it("refuses a config its schema rejects, naming the field, and leaves it running", async () => {
    const alpha = configurable("alpha");

    const failure = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return yield* Effect.flip(
          Effect.flatMap(Plugins, (plugins) =>
            plugins.configure("alpha", { config: { model: 42 } }),
          ),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    const issues = (
      failure as {
        readonly error: {
          readonly details: {
            readonly issues: ReadonlyArray<{ path: ReadonlyArray<string>; message: string }>;
          };
        };
      }
    ).error.details.issues;
    expect(issues[0]?.path).toEqual(["model"]);
    expect(issues[0]?.message.length).toBeGreaterThan(0);
    // Nothing was written, so nothing was restarted.
    expect(alpha.calls).toEqual(["activate"]);
  });
});

describe("a plugin whose activate fails", () => {
  it("is errored after one attempt, and the failure is on the audit log", async () => {
    const flaky = fixture({ id: "flaky", activateFailures: 1 });

    const { detail, errors } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([flaky.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("flaky")),
          errors: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.errored")),
        };
      }),
    );

    // No automatic retry: a broken plugin retrying on its own is noise.
    expect(flaky.calls).toEqual(["activate"]);
    expect(detail.status).toEqual({ _tag: "errored", message: "flaky could not start" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      pluginId: "flaky",
      phase: "activate",
      message: "flaky could not start",
    });
  });

  it("runs activate once more when the user retries, and comes up active", async () => {
    const flaky = fixture({ id: "flaky", activateFailures: 1 });

    const { detail, rows } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([flaky.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.retry("flaky")),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.retried")),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "flaky" } }]);
    expect(flaky.calls).toEqual(["activate", "activate"]);
    expect(detail.status).toEqual({ _tag: "active" });
  });
});

describe("retrying a plugin that is not errored", () => {
  it("is refused, so the button is never a second spelling of enable", async () => {
    const alpha = fixture({ id: "alpha" });

    const failure = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return yield* Effect.flip(Effect.flatMap(Plugins, (plugins) => plugins.retry("alpha")));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(alpha.calls).toEqual(["activate"]);
  });
});

describe("a plugin whose deactivate fails", () => {
  it("is errored with the leftover machinery said out loud, and its contributions read disabled", async () => {
    const stuck = fixture({ id: "stuck", deactivateFails: "the poll loop would not stop" });

    const { detail, errors } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([stuck.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.disable("stuck")),
          errors: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.errored")),
        };
      }),
    );

    expect(detail.status).toEqual({
      _tag: "errored",
      message: "the poll loop would not stop",
    });
    expect(detail.contributions[0]?.ownerEnabled).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      pluginId: "stuck",
      phase: "deactivate",
      message: "the poll loop would not stop",
    });
  });
});

describe("the key-value store a plugin is given", () => {
  const stateful = (id: string) => fixture({ id, capabilities: ["providers", "kv"] });

  it("is namespaced by plugin, so one plugin never reads another's key", async () => {
    const alpha = stateful("alpha");
    const beta = stateful("beta");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* kvOf(alpha).set("k", 1);
        yield* kvOf(beta).set("k", 2);
        return {
          alpha: yield* kvOf(alpha).get("k"),
          beta: yield* kvOf(beta).get("k"),
          alphaKeys: yield* kvOf(alpha).list(),
        };
      }),
    );

    expect(Option.getOrNull(read.alpha)).toBe(1);
    expect(Option.getOrNull(read.beta)).toBe(2);
    expect(read.alphaKeys).toEqual(["k"]);
  });

  it("forgets a key that was deleted", async () => {
    const alpha = stateful("alpha");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* kvOf(alpha).set("k", 1);
        yield* kvOf(alpha).delete("k");
        return { value: yield* kvOf(alpha).get("k"), keys: yield* kvOf(alpha).list() };
      }),
    );

    expect(Option.isNone(read.value)).toBe(true);
    expect(read.keys).toEqual([]);
  });

  it("survives a disable, because re-enabling resumes where the plugin left off", async () => {
    const alpha = stateful("alpha");

    const value = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* kvOf(alpha).set("cursor", "2026-09-06");
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        yield* plugins.enable("alpha");
        return yield* kvOf(alpha).get("cursor");
      }),
    );

    expect(Option.getOrNull(value)).toBe("2026-09-06");
  });
});

describe("resetting a plugin's state", () => {
  const stateful = (id: string) => fixture({ id, capabilities: ["providers", "kv"] });

  it("wipes that plugin's keys only, restarts it, and says so on the audit log", async () => {
    const alpha = stateful("alpha");
    const beta = stateful("beta");

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* kvOf(alpha).set("k", 1);
        yield* kvOf(beta).set("k", 2);
        const detail = yield* Effect.flatMap(Plugins, (plugins) => plugins.resetState("alpha"));
        return {
          detail,
          alpha: yield* kvOf(alpha).get("k"),
          beta: yield* kvOf(beta).get("k"),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.stateReset")),
        };
      }),
    );

    expect(Option.isNone(result.alpha)).toBe(true);
    expect(Option.getOrNull(result.beta)).toBe(2);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate"]);
    expect(beta.calls).toEqual(["activate"]);
    expect(result.detail.status).toEqual({ _tag: "active" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.actor).toBe("user");
  });

  it("wipes a disabled plugin's keys without starting it", async () => {
    const alpha = stateful("alpha");

    const keys = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* kvOf(alpha).set("k", 1);
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        yield* plugins.resetState("alpha");
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly key: string;
        }>`SELECT key FROM plugin_kv WHERE plugin_id = 'alpha'`;
      }),
    );

    expect(keys).toEqual([]);
    expect(alpha.calls).toEqual(["activate", "deactivate"]);
  });
});

describe("the secrets a plugin is given", () => {
  const trusted = (id: string) => fixture({ id, capabilities: ["providers", "secrets"] });

  const VALUE = "ghp_a-real-looking-token";

  it("are rows in the one secrets table, owned by the plugin, listed without their value", async () => {
    const alpha = trusted("alpha");

    const page = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* secretsOf(alpha).set("token", Redacted.make(VALUE));
        return yield* Effect.flatMap(Secret, (secret) => secret.query({}));
      }),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      ownerKind: "plugin",
      ownerId: "alpha",
      name: "token",
    });
    expect(JSON.stringify(page)).not.toContain(VALUE);
  });

  it("are scoped to their owner, so one plugin never reads or lists another's", async () => {
    const alpha = trusted("alpha");
    const beta = trusted("beta");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* secretsOf(alpha).set("token", Redacted.make(VALUE));
        return {
          alphaValue: yield* secretsOf(alpha).get("token"),
          alphaNames: yield* secretsOf(alpha).list(),
          betaValue: yield* secretsOf(beta).get("token"),
          betaNames: yield* secretsOf(beta).list(),
        };
      }),
    );

    expect(Option.isSome(read.alphaValue) && Redacted.value(read.alphaValue.value)).toBe(VALUE);
    expect(read.alphaNames).toEqual(["token"]);
    expect(Option.isNone(read.betaValue)).toBe(true);
    expect(read.betaNames).toEqual([]);
  });

  it("are gone from the table once the plugin deletes one", async () => {
    const alpha = trusted("alpha");

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* secretsOf(alpha).set("token", Redacted.make(VALUE));
        yield* secretsOf(alpha).delete("token");
        return {
          value: yield* secretsOf(alpha).get("token"),
          page: yield* Effect.flatMap(Secret, (secret) => secret.query({})),
        };
      }),
    );

    expect(Option.isNone(result.value)).toBe(true);
    expect(result.page.items).toEqual([]);
  });
});

describe("configuring a plugin whose deactivate failed", () => {
  it("stores the config but does not start it on top of the machinery left behind", async () => {
    const stuck = fixture({
      id: "stuck",
      configSchema: Schema.Struct({ model: Schema.optionalKey(Schema.String) }),
      deactivateFails: "the poll loop would not stop",
    });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([stuck.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) =>
          plugins.configure("stuck", { config: { model: "sonnet" } }),
        );
      }),
    );

    expect(stuck.calls).toEqual(["activate", "deactivate"]);
    expect(detail.config).toEqual({ model: "sonnet" });
    // Only a restart clears what the plugin left running, so the state it is in
    // is not hidden by a second activation.
    expect(detail.status).toEqual({ _tag: "errored", message: "the poll loop would not stop" });
  });
});

describe("a plugin that answers with a different manifest after it is loaded", () => {
  it("stays scoped by the manifest it was loaded with", async () => {
    const victim = fixture({ id: "victim", capabilities: ["providers", "kv", "secrets"] });
    const shifty = fixture({ id: "shifty", capabilities: ["providers", "kv", "secrets"] });
    const own = shifty.plugin.manifest;
    let reads = 0;
    const disguised: Plugin = {
      ...shifty.plugin,
      get manifest() {
        reads += 1;
        return reads === 1 ? own : { ...own, id: "victim" };
      },
    };

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([victim.plugin, disguised]);
        yield* kvOf(shifty).set("k", 1);
        yield* secretsOf(shifty).set("token", Redacted.make("shhh"));
        return {
          victimKey: yield* kvOf(victim).get("k"),
          victimSecrets: yield* secretsOf(victim).list(),
          owners: (yield* Effect.flatMap(Plugins, (plugins) => plugins.query())).map((detail) => ({
            id: detail.id,
            contributions: detail.contributions.map((c) => c.id),
          })),
        };
      }),
    );

    expect(Option.isNone(read.victimKey)).toBe(true);
    expect(read.victimSecrets).toEqual([]);
    expect(read.owners).toEqual([
      { id: "victim", contributions: ["victim-provider"] },
      { id: "shifty", contributions: ["shifty-provider"] },
    ]);
  });
});

describe("a plugin that only a restart can start again", () => {
  it("refuses a retry after its register failed, because it contributed nothing to run", async () => {
    const broken = fixture({ id: "broken", registerFails: "the manifest names no provider" });

    const { failure, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([broken.plugin]);
        const plugins = yield* Plugins;
        return {
          failure: yield* Effect.flip(plugins.retry("broken")),
          detail: yield* plugins.read("broken"),
        };
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toContain("restart");
    expect(broken.calls).toEqual([]);
    expect(detail.contributions).toEqual([]);
  });

  it("refuses a retry after its deactivate failed, because that instance is still up", async () => {
    const stuck = fixture({ id: "stuck", deactivateFails: "the poll loop would not stop" });

    const failure = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([stuck.plugin]);
        const plugins = yield* Plugins;
        yield* plugins.disable("stuck");
        return yield* Effect.flip(plugins.retry("stuck"));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toContain("restart");
    // No second instance was started on top of what the first one left behind.
    expect(stuck.calls).toEqual(["activate", "deactivate"]);
  });
});

describe("two moves on one plugin at the same time", () => {
  it("tears a plugin down once when it is disabled twice at once", async () => {
    const alpha = fixture({ id: "alpha", slow: true });

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        const plugins = yield* Plugins;
        yield* Effect.all([plugins.disable("alpha"), plugins.disable("alpha")], {
          concurrency: "unbounded",
        });
        return yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.disabled"));
      }),
    );

    expect(alpha.calls).toEqual(["activate", "deactivate"]);
    expect(result).toHaveLength(1);
  });

  it("leaves nothing running when a disable races a retry", async () => {
    const flaky = fixture({ id: "flaky", activateFailures: 1, slow: true });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([flaky.plugin]);
        const plugins = yield* Plugins;
        // Either order is a legal outcome; what neither may leave is an
        // instance still up under a row that says the plugin is off.
        yield* Effect.all(
          [Effect.result(plugins.retry("flaky")), Effect.result(plugins.disable("flaky"))],
          { concurrency: "unbounded" },
        );
        return yield* plugins.read("flaky");
      }),
    );

    expect(detail.enabled).toBe(false);
    expect(flaky.running()).toBe(false);
  });
});

describe("a move that changes nothing", () => {
  it("does not start an enabled plugin a second time", async () => {
    const alpha = fixture({ id: "alpha" });

    const rows = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* Effect.flatMap(Plugins, (plugins) => plugins.enable("alpha"));
        return yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.enabled"));
      }),
    );

    expect(alpha.calls).toEqual(["activate"]);
    expect(rows).toEqual([]);
  });

  it("does not tear a disabled plugin down a second time", async () => {
    const alpha = fixture({ id: "alpha" });

    const rows = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        yield* plugins.disable("alpha");
        return yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.disabled"));
      }),
    );

    expect(alpha.calls).toEqual(["activate", "deactivate"]);
    expect(rows).toHaveLength(1);
  });
});

describe("a plugin that was never loaded", () => {
  it("refuses every move, because there is nothing to act on", async () => {
    const ahead = fixture({ id: "ahead" });
    const future: Plugin = {
      ...ahead.plugin,
      manifest: { ...ahead.plugin.manifest, hostApi: HOST_API + 1 },
    };

    const failures = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([future]);
        const plugins = yield* Plugins;
        return {
          enable: yield* Effect.flip(plugins.enable("ahead")),
          disable: yield* Effect.flip(plugins.disable("ahead")),
          configure: yield* Effect.flip(plugins.configure("ahead", { config: {} })),
          retry: yield* Effect.flip(plugins.retry("ahead")),
          resetState: yield* Effect.flip(plugins.resetState("ahead")),
        };
      }),
    );

    for (const failure of Object.values(failures)) {
      expect(failure).toMatchObject({ error: { code: "validation" } });
    }
  });
});

describe("an empty key or secret name", () => {
  it("is refused by the surface, so the plugin reads a sentence and not a statement", async () => {
    const alpha = fixture({ id: "alpha", capabilities: ["providers", "kv", "secrets"] });

    const failures = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return {
          key: yield* Effect.flip(Effect.sandbox(kvOf(alpha).set("", 1))),
          name: yield* Effect.flip(Effect.sandbox(secretsOf(alpha).set("", Redacted.make("shhh")))),
        };
      }),
    );

    expect(Cause.squash(failures.key)).toMatchObject({ message: "A plugin key cannot be empty." });
    expect(Cause.squash(failures.name)).toMatchObject({
      message: "A plugin name cannot be empty.",
    });
  });
});

describe("disabling a plugin whose activate failed", () => {
  it("leaves it inactive rather than errored, so Retry is not offered on a plugin that is off", async () => {
    const flaky = fixture({ id: "flaky", activateFailures: 1 });

    const { detail, failure } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([flaky.plugin]);
        const plugins = yield* Plugins;
        return {
          detail: yield* plugins.disable("flaky"),
          failure: yield* Effect.flip(plugins.retry("flaky")),
        };
      }),
    );

    expect(detail.status).toEqual({ _tag: "inactive" });
    expect(detail.enabled).toBe(false);
    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(flaky.calls).toEqual(["activate"]);
  });
});

describe("a plugin that fails with a very long message", () => {
  it("has it cut before it reaches the log, which keeps what it is told for months", async () => {
    const shouted = "x".repeat(10_000);
    const shouty: Plugin = {
      ...fixture({ id: "shouty" }).plugin,
      activate: () => Effect.fail(new PluginError({ message: shouted })),
    };

    const rows = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([shouty]);
        return yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.errored"));
      }),
    );

    const message = rows[0]?.payload.message as string;
    expect(message.length).toBeLessThan(shouted.length);
    expect(message.endsWith("...")).toBe(true);
  });
});
