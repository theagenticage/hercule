/**
 * What happens to a plugin after it has registered. The behaviour spans the host
 * and the operation service, so both are driven here rather than split across
 * two files that would each see half of every outcome.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Option, Redacted, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  HOST_API,
  PluginError,
  type ActivationContext,
  type Plugin,
  type KeyValueStore,
  type PluginSecrets,
  type RegistrationHost,
} from "@hercule/plugin-host";
import { CurrentActor } from "../actor";
import { AuditLog } from "../events";
import { Secret, Secrets } from "../secrets";
import { PluginHost, Plugins } from "./index";
import { pluginRepository } from "./repository";
import { asUser, createPluginFixture, buildPluginStack, USER, type Fixture } from "./testing";

type Services = Plugins | PluginHost | Secret | Secrets | AuditLog | SqlClient.SqlClient;

/** Every call runs on a stack of its own, as the user a request would arrive as. */
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(body.pipe(Effect.provide(buildPluginStack()), asUser));

/**
 * The catalog's own column, not the plugin's: a contribution outlives its owner
 * being turned off, so a picker can say what is missing.
 */
const readOwnerEnabled = (id: string) =>
  Effect.map(
    Effect.flatMap(pluginRepository, (repository) => repository.contributions()),
    (byOwner) => (byOwner.get(id) ?? []).map((row) => row.ownerEnabled),
  );

/** The context of the plugin's most recent activation: what it is running with. */
const readCurrentContext = (of: Fixture): ActivationContext => {
  const ctx = of.contexts.at(-1);
  if (ctx === undefined) throw new Error(`${of.plugin.manifest.id} was never activated`);
  return ctx;
};

const readKeyValueStore = (of: Fixture): KeyValueStore => {
  const kv = readCurrentContext(of).kv;
  if (kv === undefined) throw new Error(`${of.plugin.manifest.id} was given no kv surface`);
  return kv;
};

const readPluginSecrets = (of: Fixture): PluginSecrets => {
  const secrets = readCurrentContext(of).secrets;
  if (secrets === undefined) {
    throw new Error(`${of.plugin.manifest.id} was given no secrets surface`);
  }
  return secrets;
};

describe("what a plugin's hooks are handed", () => {
  it("gives register the providers surface only, whatever else the manifest asked for", async () => {
    const everything = createPluginFixture({
      id: "everything",
      capabilities: ["providers", "kv", "secrets"],
    });

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
    const bare = createPluginFixture({ id: "bare", capabilities: ["providers"] });
    const stateful = createPluginFixture({ id: "stateful", capabilities: ["providers", "kv"] });
    const trusted = createPluginFixture({
      id: "trusted",
      capabilities: ["providers", "kv", "secrets"],
    });

    await run(
      Effect.flatMap(PluginHost, (host) =>
        host.boot([bare.plugin, stateful.plugin, trusted.plugin]),
      ),
    );

    expect(readCurrentContext(bare).kv).toBeUndefined();
    expect(readCurrentContext(bare).secrets).toBeUndefined();

    expect(readCurrentContext(stateful).kv).toBeDefined();
    expect(readCurrentContext(stateful).secrets).toBeUndefined();

    expect(readCurrentContext(trusted).kv).toBeDefined();
    expect(readCurrentContext(trusted).secrets).toBeDefined();
  });
});

/**
 * A row as an earlier boot left it, so this boot's activation pass is the first
 * one and finds a plugin the user already disabled or configured.
 */
const insertPluginState = (id: string, enabled: 0 | 1, config: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO plugins (id, enabled, config, created_at, updated_at)
      VALUES (${id}, ${enabled}, ${config}, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')
    `,
  );

describe("the activation pass at the end of a boot", () => {
  it("activates each enabled plugin with its stored config, and leaves a disabled one alone", async () => {
    const enabled = createPluginFixture({
      id: "enabled",
      configSchema: Schema.Struct({
        model: Schema.String,
        retries: Schema.optionalKey(Schema.Finite),
      }),
    });
    const other = createPluginFixture({ id: "other" });
    const off = createPluginFixture({ id: "off" });

    await run(
      Effect.gen(function* () {
        yield* insertPluginState("enabled", 1, '{"model":"opus"}');
        yield* insertPluginState("off", 0, "{}");
        yield* Effect.flatMap(PluginHost, (host) =>
          host.boot([enabled.plugin, other.plugin, off.plugin]),
        );
      }),
    );

    expect(enabled.calls).toEqual(["activate"]);
    expect(other.calls).toEqual(["activate"]);
    expect(off.calls).toEqual([]);
    expect(readCurrentContext(enabled).config).toEqual({ model: "opus" });
  });

  it("errors an enabled plugin whose stored config no longer decodes, and does not activate it", async () => {
    const drifted = createPluginFixture({
      id: "drifted",
      configSchema: Schema.Struct({ model: Schema.String }),
    });

    const detail = await run(
      Effect.gen(function* () {
        // What a plugin whose schema changed between two versions leaves behind.
        yield* insertPluginState("drifted", 1, '{"model":42}');
        yield* Effect.flatMap(PluginHost, (host) => host.boot([drifted.plugin]));
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("drifted"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    expect((detail.status as { readonly message: string }).message).toContain("model");
    expect(drifted.calls).toEqual([]);
  });
});

describe("disabling and enabling a plugin", () => {
  it("deactivates it, marks it inactive, and marks its contributions as a disabled plugin's", async () => {
    const alpha = createPluginFixture({ id: "alpha" });
    const beta = createPluginFixture({ id: "beta" });

    const { detail, rows, owned } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.disable("alpha")),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.disabled")),
          owned: yield* readOwnerEnabled("alpha"),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate"]);
    expect(detail.status).toEqual({ _tag: "inactive" });
    expect(detail.enabled).toBe(false);
    expect(detail.contributions).toHaveLength(1);
    expect(owned).toEqual([false]);
    expect(beta.calls).toEqual(["activate"]);
  });

  it("activates it again when it is enabled", async () => {
    const alpha = createPluginFixture({ id: "alpha" });

    const { detail, rows, owned } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        return {
          detail: yield* plugins.enable("alpha"),
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.enabled")),
          owned: yield* readOwnerEnabled("alpha"),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate"]);
    expect(detail.status).toEqual({ _tag: "active" });
    expect(detail.enabled).toBe(true);
    expect(owned).toEqual([true]);
  });
});

describe("configuring a plugin", () => {
  // The key is optional, so the plugin starts on the empty config it is
  // installed with and the test can then configure a running plugin.
  const buildConfigurableFixture = (id: string) =>
    createPluginFixture({
      id,
      configSchema: Schema.Struct({ model: Schema.optionalKey(Schema.String) }),
    });

  it("restarts it with the new config, and stores what it was restarted with", async () => {
    const alpha = buildConfigurableFixture("alpha");

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
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate"]);
    expect(readCurrentContext(alpha).config).toEqual({ model: "sonnet" });
    expect(detail.config).toEqual({ model: "sonnet" });
  });

  it("refuses a config its schema rejects, naming the field, and leaves it running", async () => {
    const alpha = buildConfigurableFixture("alpha");

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
    expect(alpha.calls).toEqual(["activate"]);
  });
});

describe("a plugin whose activate fails", () => {
  it("is errored after one attempt, and the failure is on the audit log", async () => {
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1 });

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
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1 });

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
    const alpha = createPluginFixture({ id: "alpha" });

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
    const stuck = createPluginFixture({
      id: "stuck",
      deactivateFails: "the poll loop would not stop",
    });

    const { detail, errors, owned } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([stuck.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.disable("stuck")),
          errors: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.errored")),
          owned: yield* readOwnerEnabled("stuck"),
        };
      }),
    );

    expect(detail.status).toEqual({
      _tag: "errored",
      message: "the poll loop would not stop",
    });
    expect(owned).toEqual([false]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toEqual({
      pluginId: "stuck",
      phase: "deactivate",
      message: "the poll loop would not stop",
    });
  });
});

describe("the key-value store a plugin is given", () => {
  const buildStatefulFixture = (id: string) =>
    createPluginFixture({ id, capabilities: ["providers", "kv"] });

  it("is namespaced by plugin, so one plugin never reads another's key", async () => {
    const alpha = buildStatefulFixture("alpha");
    const beta = buildStatefulFixture("beta");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* readKeyValueStore(alpha).set("k", 1);
        yield* readKeyValueStore(beta).set("k", 2);
        return {
          alpha: yield* readKeyValueStore(alpha).get("k"),
          beta: yield* readKeyValueStore(beta).get("k"),
          alphaKeys: yield* readKeyValueStore(alpha).list(),
        };
      }),
    );

    expect(Option.getOrNull(read.alpha)).toBe(1);
    expect(Option.getOrNull(read.beta)).toBe(2);
    expect(read.alphaKeys).toEqual(["k"]);
  });

  it("forgets a key that was deleted", async () => {
    const alpha = buildStatefulFixture("alpha");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* readKeyValueStore(alpha).set("k", 1);
        yield* readKeyValueStore(alpha).delete("k");
        return {
          value: yield* readKeyValueStore(alpha).get("k"),
          keys: yield* readKeyValueStore(alpha).list(),
        };
      }),
    );

    expect(Option.isNone(read.value)).toBe(true);
    expect(read.keys).toEqual([]);
  });

  it("survives a disable, because re-enabling resumes where the plugin left off", async () => {
    const alpha = buildStatefulFixture("alpha");

    const value = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* readKeyValueStore(alpha).set("cursor", "2026-09-06");
        const plugins = yield* Plugins;
        yield* plugins.disable("alpha");
        yield* plugins.enable("alpha");
        return yield* readKeyValueStore(alpha).get("cursor");
      }),
    );

    expect(Option.getOrNull(value)).toBe("2026-09-06");
  });
});

describe("resetting a plugin's state", () => {
  const buildStatefulFixture = (id: string) =>
    createPluginFixture({ id, capabilities: ["providers", "kv"] });

  it("wipes that plugin's keys only, restarts it, and says so on the audit log", async () => {
    const alpha = buildStatefulFixture("alpha");
    const beta = buildStatefulFixture("beta");

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* readKeyValueStore(alpha).set("k", 1);
        yield* readKeyValueStore(beta).set("k", 2);
        const detail = yield* Effect.flatMap(Plugins, (plugins) => plugins.resetState("alpha"));
        return {
          detail,
          alpha: yield* readKeyValueStore(alpha).get("k"),
          beta: yield* readKeyValueStore(beta).get("k"),
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
    const alpha = buildStatefulFixture("alpha");

    const keys = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* readKeyValueStore(alpha).set("k", 1);
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
  const buildTrustedFixture = (id: string) =>
    createPluginFixture({ id, capabilities: ["providers", "secrets"] });

  const VALUE = "ghp_a-real-looking-token";

  it("are rows in the one secrets table, owned by the plugin, listed without their value", async () => {
    const alpha = buildTrustedFixture("alpha");

    const page = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* readPluginSecrets(alpha).set("token", Redacted.make(VALUE));
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
    const alpha = buildTrustedFixture("alpha");
    const beta = buildTrustedFixture("beta");

    const read = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* readPluginSecrets(alpha).set("token", Redacted.make(VALUE));
        return {
          alphaValue: yield* readPluginSecrets(alpha).get("token"),
          alphaNames: yield* readPluginSecrets(alpha).list(),
          betaValue: yield* readPluginSecrets(beta).get("token"),
          betaNames: yield* readPluginSecrets(beta).list(),
        };
      }),
    );

    expect(Option.isSome(read.alphaValue) && Redacted.value(read.alphaValue.value)).toBe(VALUE);
    expect(read.alphaNames).toEqual(["token"]);
    expect(Option.isNone(read.betaValue)).toBe(true);
    expect(read.betaNames).toEqual([]);
  });

  it("are gone from the table once the plugin deletes one", async () => {
    const alpha = buildTrustedFixture("alpha");

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* readPluginSecrets(alpha).set("token", Redacted.make(VALUE));
        yield* readPluginSecrets(alpha).delete("token");
        return {
          value: yield* readPluginSecrets(alpha).get("token"),
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
    const stuck = createPluginFixture({
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
    expect(detail.status).toEqual({ _tag: "errored", message: "the poll loop would not stop" });
  });
});

describe("a plugin that answers with a different manifest after it is loaded", () => {
  it("stays scoped by the manifest it was loaded with", async () => {
    const victim = createPluginFixture({
      id: "victim",
      capabilities: ["providers", "kv", "secrets"],
    });
    const shifty = createPluginFixture({
      id: "shifty",
      capabilities: ["providers", "kv", "secrets"],
    });
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
        yield* readKeyValueStore(shifty).set("k", 1);
        yield* readPluginSecrets(shifty).set("token", Redacted.make("shhh"));
        return {
          victimKey: yield* readKeyValueStore(victim).get("k"),
          victimSecrets: yield* readPluginSecrets(victim).list(),
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
    const broken = createPluginFixture({
      id: "broken",
      registerFails: "the manifest names no provider",
    });

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
    const stuck = createPluginFixture({
      id: "stuck",
      deactivateFails: "the poll loop would not stop",
    });

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
    expect(stuck.calls).toEqual(["activate", "deactivate"]);
  });
});

describe("two moves on one plugin at the same time", () => {
  it("tears a plugin down once when it is disabled twice at once", async () => {
    const alpha = createPluginFixture({ id: "alpha", slow: true });

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
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1, slow: true });

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
    const alpha = createPluginFixture({ id: "alpha" });

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
    const alpha = createPluginFixture({ id: "alpha" });

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
    const ahead = createPluginFixture({ id: "ahead" });
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
    const alpha = createPluginFixture({
      id: "alpha",
      capabilities: ["providers", "kv", "secrets"],
    });

    const failures = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return {
          key: yield* Effect.flip(Effect.sandbox(readKeyValueStore(alpha).set("", 1))),
          name: yield* Effect.flip(
            Effect.sandbox(readPluginSecrets(alpha).set("", Redacted.make("shhh"))),
          ),
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
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1 });

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
      ...createPluginFixture({ id: "shouty" }).plugin,
      activate: () => Effect.fail(new PluginError({ message: shouted })),
    };

    const { rows, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([shouty]);
        return {
          rows: yield* Effect.flatMap(AuditLog, (log) => log.listByKind("plugin.errored")),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("shouty")),
        };
      }),
    );

    const message = rows[0]?.payload.message as string;
    expect(message.length).toBeLessThan(shouted.length);
    expect(message.endsWith("...")).toBe(true);
    expect(detail.status).toEqual({ _tag: "errored", message });
  });
});

describe("a caller with no credential behind it", () => {
  it("is refused by every operation, before anything is read or run", async () => {
    const alpha = createPluginFixture({ id: "alpha" });

    const { failures, rows } = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        // The boot is not an operation: it runs with nobody behind it on every
        // start, so it is arranged outside the ungated call below.
        yield* Effect.provideService(host.boot([alpha.plugin]), CurrentActor, USER);
        const plugins = yield* Plugins;
        const failures = yield* Effect.all([
          Effect.flip(plugins.query()),
          Effect.flip(plugins.read("alpha")),
          Effect.flip(plugins.enable("alpha")),
          Effect.flip(plugins.disable("alpha")),
          Effect.flip(plugins.configure("alpha", { config: {} })),
          Effect.flip(plugins.retry("alpha")),
          Effect.flip(plugins.resetState("alpha")),
        ]);
        const log = yield* AuditLog;
        return {
          failures,
          rows: yield* Effect.forEach(
            [
              "plugin.enabled",
              "plugin.disabled",
              "plugin.configured",
              "plugin.retried",
              "plugin.stateReset",
            ] as const,
            (kind) => log.listByKind(kind),
          ),
        };
      }).pipe(Effect.provide(buildPluginStack())),
    );

    for (const failure of failures) {
      expect(failure).toMatchObject({ error: { code: "forbidden" } });
    }
    expect(alpha.calls).toEqual(["activate"]);
    expect(rows.flat()).toEqual([]);
  });
});
