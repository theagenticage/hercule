/**
 * Tests how the `textGeneration.model` setting resolves to a Provider
 * Account, a harness and a model, on a real database with stored snapshots
 * and Model Catalogs and no runner connected.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { withTransaction } from "../db";
import { inTransaction } from "../db/testing";
import { PluginHost } from "../plugins";
import { buildPluginStack } from "../plugins/testing";
import {
  ModelCatalogsLayer,
  ProviderAccountRunnersLayer,
  providerAccountRepository,
  type StoredProviderAccount,
} from "../provider-accounts";
import { inertMembership } from "../provider-accounts/testing";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { Settings, SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import { TextGenerationModels, TextGenerationModelsLayer } from "./models";
import {
  addCatalog,
  addFixtureAccount,
  addSnapshot,
  addTextGenerationRunner,
  buildProbeResult as probed,
  buildTextGenerationPlugins,
  type RunnerTraits,
} from "./testing";

const layer = TextGenerationModelsLayer.pipe(
  Layer.provideMerge(ModelCatalogsLayer),
  Layer.provideMerge(inertMembership),
  Layer.provideMerge(ProviderAccountRunnersLayer),
  Layer.provideMerge(AccountUsageLayer),
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(buildPluginStack()),
);

/** An account of each automatic provider, arranged by `run`. */
interface Fleet {
  readonly openai: StoredProviderAccount;
  readonly zai: StoredProviderAccount;
  readonly anthropic: StoredProviderAccount;
  readonly addRunner: (traits?: RunnerTraits) => Effect.Effect<string, never, SqlClient.SqlClient>;
  /**
   * Stores a snapshot of an account in its own default harness. A snapshot
   * that finds the account signed in is also the account's Model Catalog
   * read, listing the same models.
   */
  readonly snapshot: (
    account: StoredProviderAccount,
    runner: string,
    result: ReturnType<typeof probed>,
  ) => Effect.Effect<void, never, SqlClient.SqlClient>;
}

const run = <A>(
  arrange: (
    fleet: Fleet,
  ) => Effect.Effect<
    A,
    unknown,
    Settings | TextGenerationModels | SqlClient.SqlClient | PluginHost | Secrets
  >,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
      return yield* arrange({
        // Added in this order, a day apart, which is the order `automatic` walks.
        openai: yield* addFixtureAccount("openai", null, "2026-10-01T00:00:00.000Z"),
        zai: yield* addFixtureAccount("zai", null, "2026-10-02T00:00:00.000Z"),
        anthropic: yield* addFixtureAccount("anthropic", null, "2026-10-03T00:00:00.000Z"),
        addRunner: (traits) => Effect.orDie(addTextGenerationRunner(traits)),
        snapshot: (account, runner, result) =>
          Effect.orDie(
            Effect.gen(function* () {
              yield* addSnapshot(account.id, account.defaultHarnessId, runner, result);
              if (result.auth.status === "ok") yield* addCatalog(account.id, result);
            }),
          ),
      });
    }).pipe(Effect.orDie, Effect.provide(layer)),
  );

const resolve = Effect.flatMap(TextGenerationModels, (models) => models.resolve());

describe("automatic", () => {
  it("picks the oldest account whose provider's suggested model its model list holds", async () => {
    const target = await run(({ openai, zai, anthropic, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "something-else"));
        yield* snapshot(zai, runner, probed("ok", "glm-5.3-flash"));
        yield* snapshot(anthropic, runner, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      providerAccountName: "Z.ai",
      harnessId: "pi/pi",
      model: "glm-5.3-flash",
      runnerIds: [expect.any(String) as unknown],
    });
  });

  it("looks the suggested model up in the Model Catalog, not in the snapshots", async () => {
    const [fromSnapshot, fromCatalog] = await run(({ openai, zai, addRunner }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        // The harness lists the model on the runner, but the catalog was never read.
        yield* Effect.orDie(
          addSnapshot(openai.id, openai.defaultHarnessId, runner, probed("ok", "gpt-6-luna")),
        );
        const beforeRead = yield* resolve.pipe(Effect.orDie);
        // The catalog lists a model that no snapshot has.
        yield* Effect.orDie(addCatalog(zai.id, probed("ok", "glm-5.3-flash")));
        return [beforeRead, yield* resolve.pipe(Effect.orDie)] as const;
      }),
    );

    expect(fromSnapshot._tag).toBe("unresolved");
    expect(fromCatalog).toMatchObject({ _tag: "resolved", harnessId: "pi/pi" });
  });

  it("picks the oldest account whatever its provider, not a fixed order of providers", async () => {
    const target = await run(({ openai, anthropic, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        const oldest = yield* Effect.orDie(
          addFixtureAccount("anthropic", "first", "2026-09-01T00:00:00.000Z"),
        );
        yield* snapshot(oldest, runner, probed("ok", "haiku"));
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        yield* snapshot(anthropic, runner, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      providerAccountId: expect.any(String) as unknown,
      providerAccountName: "Anthropic · first",
    });
  });

  it("skips an older key account whose key is gone and takes the next account", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        const secrets = yield* Secrets;
        const keyless = yield* Effect.orDie(
          addFixtureAccount("zai", "keyless", "2026-09-01T00:00:00.000Z"),
        );
        yield* snapshot(keyless, runner, probed("ok", "glm-5.3-flash"));
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          secrets.delete(buildProviderAccountOwner(keyless.id), "apiKey"),
        ).pipe(Effect.orDie);
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
  });

  it("skips an account whose harness is older than this build supports on every runner", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, { ...probed("ok", "gpt-6-luna"), harnessVersion: "0.0.1" });
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target._tag).toBe("unresolved");
  });

  it("skips an account whose harness is installed on no runner", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const bare = yield* addRunner({ harnessesInstalled: false });
        yield* snapshot(openai, bare, probed("ok", "gpt-6-luna"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target._tag).toBe("unresolved");
  });

  it("takes the oldest account that is signed in, and skips an older one that is not", async () => {
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
        const signedOut = yield* addFixtureAccount(
          "openai",
          "signed out",
          "2026-10-01T00:00:00.000Z",
        );
        const older = yield* addFixtureAccount("openai", "older", "2026-10-02T00:00:00.000Z");
        const newer = yield* addFixtureAccount("openai", "newer", "2026-10-03T00:00:00.000Z");
        const runner = yield* addTextGenerationRunner();
        yield* addSnapshot(
          signedOut.id,
          signedOut.defaultHarnessId,
          runner,
          probed("unauthenticated", "gpt-6-luna"),
        );
        for (const account of [newer, older]) {
          yield* addSnapshot(
            account.id,
            account.defaultHarnessId,
            runner,
            probed("ok", "gpt-6-luna"),
          );
          yield* addCatalog(account.id, probed("ok", "gpt-6-luna"));
        }
        return { target: yield* resolve, olderId: older.id };
      }).pipe(Effect.orDie, Effect.provide(layer)),
    );

    expect(target.target).toMatchObject({
      _tag: "resolved",
      providerAccountId: target.olderId,
      providerAccountName: "OpenAI · older",
    });
  });

  it("skips a sign-in that expired, and runs a key account on an open runner using the models a reserved runner reported", async () => {
    const target = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const open = yield* addRunner();
        const reserved = yield* addRunner({ reserved: true });
        yield* snapshot(openai, open, probed("unauthenticated", "gpt-6-luna"));
        yield* snapshot(zai, reserved, probed("ok", "glm-5.3-flash"));
        return [yield* resolve.pipe(Effect.orDie), open] as const;
      }),
    );

    expect(target[0]).toMatchObject({
      _tag: "resolved",
      harnessId: "pi/pi",
      model: "glm-5.3-flash",
      runnerIds: [target[1]],
    });
  });

  it("skips an account that is signed in only on an offline runner", async () => {
    const target = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const offline = yield* addRunner({ online: false });
        const online = yield* addRunner();
        yield* snapshot(openai, offline, probed("ok", "gpt-6-luna"));
        yield* snapshot(zai, online, probed("ok", "glm-5.3-flash"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", harnessId: "pi/pi" });
  });

  it("skips an account that is signed in only on a runner without the text generation capability", async () => {
    const target = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const old = yield* addRunner({ capable: false });
        const current = yield* addRunner();
        yield* snapshot(openai, old, probed("ok", "gpt-6-luna"));
        yield* snapshot(zai, current, probed("ok", "glm-5.3-flash"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", harnessId: "pi/pi" });
  });

  it("lists every runner that could take the call", async () => {
    const [target, expected] = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const first = yield* addRunner();
        const second = yield* addRunner();
        const offline = yield* addRunner({ online: false });
        for (const runner of [first, second, offline]) {
          yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        }
        return [yield* resolve.pipe(Effect.orDie), [first, second]] as const;
      }),
    );

    expect(target._tag === "resolved" ? [...target.runnerIds].sort() : []).toEqual(
      [...expected].sort(),
    );
  });

  it("has another failure key once it resolves to another model", async () => {
    const keys = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        yield* snapshot(zai, runner, probed("ok", "glm-5.3-flash"));
        const withOpenai = yield* resolve.pipe(Effect.orDie);
        yield* snapshot(openai, runner, probed("unauthenticated", "gpt-6-luna"));
        const withZai = yield* resolve.pipe(Effect.orDie);
        // A key account stays usable whatever its snapshots say, so its key goes instead.
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          (yield* Secrets).delete(buildProviderAccountOwner(zai.id), "apiKey"),
        ).pipe(Effect.orDie);
        const withNothing = yield* resolve.pipe(Effect.orDie);
        const again = yield* resolve.pipe(Effect.orDie);
        return {
          openai: withOpenai.failureKey,
          zai: withZai.failureKey,
          nothing: withNothing.failureKey,
          nothingAgain: again.failureKey,
        };
      }),
    );

    expect(new Set([keys.openai, keys.zai, keys.nothing]).size).toBe(3);
    expect(keys.nothingAgain).toBe(keys.nothing);
  });

  it("is unresolved, with a message that says why, when nothing matches", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "other"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("add an account that offers") as unknown,
    });
  });

  it("reads each table a fixed number of times, however many accounts there are", async () => {
    const statements: Array<string> = [];
    const countStatements: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });

    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        // Five older accounts of the first provider, none with the suggested
        // model, so every one is looked at before the last one is taken.
        for (const label of ["a", "b", "c", "d", "e"]) {
          const other = yield* Effect.orDie(
            addFixtureAccount("openai", label, "2026-09-01T00:00:00.000Z"),
          );
          yield* snapshot(other, runner, probed("ok", "other"));
        }
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        return yield* Effect.provideService(
          resolve.pipe(Effect.orDie),
          Statement.CurrentTransformer,
          countStatements,
        );
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      providerAccountId: expect.any(String) as unknown,
    });
    const reading = (table: string): number =>
      statements.filter((text) => new RegExp(`FROM ${table}\\b`).test(text)).length;
    // Each count is a constant: `automatic` lists the accounts to find its
    // candidates, `ProviderAccountRunners` lists them again, and the catalogs
    // are listed beside the accounts; the snapshots are read for the versions
    // and for the sign-ins; the runners for their facts and for the placement
    // candidates.
    expect(reading("provider_accounts")).toBe(3);
    expect(reading("capability_snapshots")).toBe(2);
    expect(reading("runners")).toBe(2);
  });

  it("is what an unset setting means", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* inTransaction(settings.set("textGeneration.model", "automatic"));
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
  });
});

describe("off", () => {
  it("resolves to off", async () => {
    const target = await run(() =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* inTransaction(settings.set("textGeneration.model", "off"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toEqual({
      _tag: "off",
      failureKey: JSON.stringify({ setting: "off", ran: null }),
    });
  });
});

describe("a chosen account and model", () => {
  it("is returned as it is, on the runners that can run the account, even when no model list holds the model", async () => {
    const [target, runnerId] = await run(({ zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(zai, runner, probed("ok", "glm-5.3-flash"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: zai.id,
            model: "not-in-any-catalog",
          }),
        );
        return [yield* resolve.pipe(Effect.orDie), runner] as const;
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      providerAccountName: "Z.ai",
      harnessId: "pi/pi",
      model: "not-in-any-catalog",
      runnerIds: [runnerId],
    });
  });

  it("runs in the account's default harness when the choice names none, and in the named harness otherwise", async () => {
    const targets = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            model: "gpt-6-luna",
          }),
        );
        const byDefault = yield* resolve.pipe(Effect.orDie);
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            harnessId: "codex/codex",
            model: "gpt-6-luna",
          }),
        );
        return { byDefault, named: yield* resolve.pipe(Effect.orDie) };
      }),
    );

    expect(targets.byDefault).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
    expect(targets.named).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
  });

  it("lists the runners that can take the call and run the account, whatever their own model lists hold", async () => {
    const [target, expected] = await run(({ zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const offers = yield* addRunner();
        const lacksModel = yield* addRunner();
        const offline = yield* addRunner({ online: false });
        const old = yield* addRunner({ capable: false });
        yield* snapshot(zai, offers, probed("ok", "glm-5.3-flash"));
        yield* snapshot(zai, lacksModel, probed("ok", "pi-large"));
        yield* snapshot(zai, offline, probed("ok", "glm-5.3-flash"));
        yield* snapshot(zai, old, probed("ok", "glm-5.3-flash"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: zai.id,
            model: "glm-5.3-flash",
          }),
        );
        return [yield* resolve.pipe(Effect.orDie), [offers, lacksModel]] as const;
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", runnerIds: expected });
  });

  it("is unresolved, naming the account, when the account cannot run in the chosen harness", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            harnessId: "pi/pi",
            model: "gpt-6-luna",
          }),
        );
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("OpenAI cannot make text generations") as unknown,
    });
  });

  it("is unresolved once the account is gone, and never replaced by automatic", async () => {
    const target = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const accounts = yield* providerAccountRepository;
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "gpt-6-luna"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: zai.id,
            model: "glm-5.3-flash",
          }),
        );
        yield* inTransaction(accounts.delete(zai.id)).pipe(Effect.orDie);
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "unresolved",
      message: expect.stringContaining("was deleted") as unknown,
    });
  });
});
