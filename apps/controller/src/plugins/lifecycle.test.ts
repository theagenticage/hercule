/**
 * Tests what happens to a plugin after it has registered. The behaviour spans
 * the host and the `Plugins` service, so both are tested here together rather
 * than in two files that would each see half of every outcome.
 */
import { describe, expect, it } from "vitest";
import { Cause, Deferred, Duration, Effect, Fiber, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
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
import { readEventsOfKind } from "../events/testing";
import { NotificationService } from "../notifications";
import { Secret, Secrets } from "../secrets";
import { connectionStateRepository } from "../connections";
import { DEACTIVATE_TIMEOUT_SECONDS } from "./host";
import { IngestLoops, PluginHost, Plugins } from "./index";
import { pluginRepository } from "./repository";
import {
  asUser,
  buildPluginStack,
  createEventSourceFixture,
  createPluginFixture,
  insertFixtureConnection,
  USER,
  type Fixture,
} from "./testing";

type Services =
  Plugins | PluginHost | IngestLoops | NotificationService | Secret | Secrets | SqlClient.SqlClient;

/** Runs an effect on a fresh plugin stack, as the user, like a request through the API. */
const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(body.pipe(Effect.provide(buildPluginStack()), asUser));

/**
 * The call a running plugin receives last in every `run`: the stack shuts down
 * when `run` returns, and shutdown deactivates every plugin still running.
 */
const AT_SHUTDOWN = "deactivate";

/**
 * Reads the `ownerEnabled` flag of each of a plugin's catalog rows. The flag
 * is on the catalog, not the plugin: a contribution stays in the catalog while
 * its plugin is off, so a picker can show what is missing.
 */
const readOwnerEnabled = (id: string) =>
  Effect.map(
    Effect.flatMap(pluginRepository, (repository) => repository.contributions()),
    (byOwner) => (byOwner.get(id) ?? []).map((row) => row.ownerEnabled),
  );

/** Returns the context of the plugin's most recent activation, which is what it runs with. */
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

describe("what a plugin's hooks receive", () => {
  it("gives register only the providers API, whatever else the manifest asks for", async () => {
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
    // Registration APIs only: a runtime API before the catalog exists would
    // let a plugin act on a system that is only half loaded.
    expect(host.kv).toBeUndefined();
    expect(host.secrets).toBeUndefined();
  });

  it("gives activate exactly the runtime APIs the manifest asks for", async () => {
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
 * Inserts a plugin row as an earlier boot would have left it, so the next
 * boot finds a plugin the user already disabled or configured.
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

    expect(enabled.calls).toEqual(["activate", AT_SHUTDOWN]);
    expect(other.calls).toEqual(["activate", AT_SHUTDOWN]);
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
        // What a plugin whose schema changed between two versions leaves
        // behind.
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
          rows: yield* readEventsOfKind("plugin.disabled"),
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
    expect(beta.calls).toEqual(["activate", AT_SHUTDOWN]);
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
          rows: yield* readEventsOfKind("plugin.enabled"),
          owned: yield* readOwnerEnabled("alpha"),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate", AT_SHUTDOWN]);
    expect(detail.status).toEqual({ _tag: "active" });
    expect(detail.enabled).toBe(true);
    expect(owned).toEqual([true]);
  });
});

describe("configuring a plugin", () => {
  // The key is optional, so the plugin starts with the empty config it is
  // installed with, and the test can then configure a running plugin.
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
          rows: yield* readEventsOfKind("plugin.configured"),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "alpha" } }]);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate", AT_SHUTDOWN]);
    expect(readCurrentContext(alpha).config).toEqual({ model: "sonnet" });
    expect(detail.config).toEqual({ model: "sonnet" });
  });

  it("rejects a config its schema rejects, names the field, and leaves the plugin running", async () => {
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
    expect(alpha.calls).toEqual(["activate", AT_SHUTDOWN]);
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
          errors: yield* readEventsOfKind("plugin.errored"),
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

  it("raises one core.plugin-error notification about the plugin", async () => {
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1 });

    const page = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([flaky.plugin]));
        return yield* Effect.flatMap(NotificationService, (notifications) =>
          notifications.query({}),
        );
      }),
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        kind: "core.plugin-error",
        title: "Plugin flaky could not start",
        body: "The error is shown on the plugin's card under Settings > Plugins.",
        producer: { type: "core" },
        subject: [{ kind: "plugin", id: "flaky" }],
        status: "resolved",
      }),
    ]);
  });

  it("runs activate once more when the user retries, and comes up active", async () => {
    const flaky = createPluginFixture({ id: "flaky", activateFailures: 1 });

    const { detail, rows } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([flaky.plugin]);
        return {
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.retry("flaky")),
          rows: yield* readEventsOfKind("plugin.retried"),
        };
      }),
    );

    expect(rows).toMatchObject([{ actor: "user", payload: { pluginId: "flaky" } }]);
    expect(flaky.calls).toEqual(["activate", "activate", AT_SHUTDOWN]);
    expect(detail.status).toEqual({ _tag: "active" });
  });
});

describe("retrying a plugin that is not errored", () => {
  it("fails with a validation error, so Retry never works as a second Enable", async () => {
    const alpha = createPluginFixture({ id: "alpha" });

    const failure = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        return yield* Effect.flip(Effect.flatMap(Plugins, (plugins) => plugins.retry("alpha")));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(alpha.calls).toEqual(["activate", AT_SHUTDOWN]);
  });
});

describe("a plugin whose deactivate fails", () => {
  it("is errored with the deactivate error as its message, and its contributions read as disabled", async () => {
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
          errors: yield* readEventsOfKind("plugin.errored"),
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

  it("is errored when its deactivate does not return in time, so the host is not held up", async () => {
    const hung = createPluginFixture({ id: "hung", deactivateHangs: true });

    const detail = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([hung.plugin]));
        const disabling = yield* Effect.forkChild(
          Effect.flatMap(Plugins, (plugins) => plugins.disable("hung")),
        );
        yield* TestClock.adjust(Duration.seconds(DEACTIVATE_TIMEOUT_SECONDS));
        return yield* Fiber.join(disabling);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(detail.status).toEqual({
      _tag: "errored",
      message: `deactivate did not return within ${DEACTIVATE_TIMEOUT_SECONDS} seconds`,
    });
  });

  it("raises a core.plugin-error notification that says the plugin could not stop", async () => {
    const stuck = createPluginFixture({
      id: "stuck",
      deactivateFails: "the poll loop would not stop",
    });

    const titles = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([stuck.plugin]));
        yield* Effect.flatMap(Plugins, (plugins) => plugins.disable("stuck"));
        const page = yield* Effect.flatMap(NotificationService, (notifications) =>
          notifications.query({ kind: "core.plugin-error" }),
        );
        return page.items.map((notification) => notification.title);
      }),
    );

    expect(titles).toEqual(["Plugin stuck could not stop"]);
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

  it("deletes only that plugin's keys, restarts it, and records it on the audit log", async () => {
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
          rows: yield* readEventsOfKind("plugin.stateReset"),
        };
      }),
    );

    expect(Option.isNone(result.alpha)).toBe(true);
    expect(Option.getOrNull(result.beta)).toBe(2);
    expect(alpha.calls).toEqual(["activate", "deactivate", "activate", AT_SHUTDOWN]);
    expect(beta.calls).toEqual(["activate", AT_SHUTDOWN]);
    expect(result.detail.status).toEqual({ _tag: "active" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.actor).toBe("user");
  });

  it("deletes a disabled plugin's keys without starting it", async () => {
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

  it("closes the plugin's ingest handles and deletes its Connections' state", async () => {
    const acme = createEventSourceFixture();
    const opened = Deferred.makeUnsafe<void>();
    acme.open = () => Effect.asVoid(Deferred.succeed(opened, undefined));

    const result = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([acme.plugin]);
        const connection = yield* insertFixtureConnection();
        const source = (yield* host.listActiveEventSources())[0];
        if (source === undefined) return yield* Effect.die("the fixture registered no source");
        const ingest = yield* IngestLoops;
        yield* ingest.open(source, connection);
        yield* Deferred.await(opened);
        const handle = acme.opened[0];
        if (handle === undefined) return yield* Effect.die("the source was never opened");
        yield* handle.context.state.set("cursor", "2026-09-06");
        yield* Effect.flatMap(Plugins, (plugins) => plugins.resetState(acme.plugin.manifest.id));
        const state = yield* connectionStateRepository;
        return {
          keys: yield* state.buildStore(connection.id).list(),
          open: yield* ingest.listOpen(),
        };
      }),
    );

    expect(result.keys).toEqual([]);
    expect(result.open).toEqual([]);
    expect(acme.calls).toContain("close");
  });
});

describe("the secrets a plugin is given", () => {
  const buildTrustedFixture = (id: string) =>
    createPluginFixture({ id, capabilities: ["providers", "secrets"] });

  const VALUE = "ghp_a-real-looking-token";

  it("are rows in the secrets table, owned by the plugin, and listed without their values", async () => {
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
  it("stores the config but does not start the plugin on top of what the failed teardown left running", async () => {
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

describe("a plugin that returns a different manifest after it is loaded", () => {
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
  it("rejects a retry after its register failed, because it contributed nothing to run", async () => {
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

  it("rejects a retry after its deactivate failed, because that instance is still running", async () => {
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

describe("two lifecycle changes on one plugin at the same time", () => {
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
        return yield* readEventsOfKind("plugin.disabled");
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
        // Either order is a valid outcome, but neither may leave an instance
        // running while the row says the plugin is off.
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

describe("a lifecycle change that changes nothing", () => {
  it("does not start an enabled plugin a second time", async () => {
    const alpha = createPluginFixture({ id: "alpha" });

    const rows = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin]);
        yield* Effect.flatMap(Plugins, (plugins) => plugins.enable("alpha"));
        return yield* readEventsOfKind("plugin.enabled");
      }),
    );

    expect(alpha.calls).toEqual(["activate", AT_SHUTDOWN]);
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
        return yield* readEventsOfKind("plugin.disabled");
      }),
    );

    expect(alpha.calls).toEqual(["activate", "deactivate"]);
    expect(rows).toHaveLength(1);
  });
});

describe("shutting the controller down", () => {
  it("closes a running plugin's ingest handles, then deactivates it", async () => {
    const acme = createEventSourceFixture();
    const opened = Deferred.makeUnsafe<void>();
    acme.open = () => Effect.asVoid(Deferred.succeed(opened, undefined));
    const plugin: Plugin = {
      ...acme.plugin,
      activate: () => Effect.succeed(Effect.sync(() => acme.calls.push("deactivate"))),
    };

    await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([plugin]);
        const connection = yield* insertFixtureConnection();
        const source = (yield* host.listActiveEventSources())[0];
        if (source === undefined) return yield* Effect.die("the fixture registered no source");
        yield* Effect.flatMap(IngestLoops, (ingest) => ingest.open(source, connection));
        yield* Deferred.await(opened);
      }),
    );

    expect(acme.calls.slice(-2)).toEqual(["close", "deactivate"]);
  });
});

describe("a plugin that was never loaded", () => {
  it("rejects every lifecycle change, because there is nothing to act on", async () => {
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
  it("is rejected by the plugin API with a plain message, before any SQL runs", async () => {
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
  it("has it truncated before it reaches the audit log, which keeps entries for months", async () => {
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
          rows: yield* readEventsOfKind("plugin.errored"),
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
  it("is rejected by every operation, before anything is read or run", async () => {
    const alpha = createPluginFixture({ id: "alpha" });

    const { failures, rows } = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        // The boot is not an operation: it runs with no actor on every start,
        // so it is set up outside the calls under test below.
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
            (kind) => readEventsOfKind(kind),
          ),
        };
      }).pipe(Effect.provide(buildPluginStack())),
    );

    for (const failure of failures) {
      expect(failure).toMatchObject({ error: { code: "forbidden" } });
    }
    expect(alpha.calls).toEqual(["activate", AT_SHUTDOWN]);
    expect(rows.flat()).toEqual([]);
  });
});
