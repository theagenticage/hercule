/**
 * Tests how the `textGeneration.model` setting resolves to a Provider
 * Account, a harness and a model, on a real database with stored snapshots
 * and no runner connected.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction } from "../db/testing";
import { PluginHost } from "../plugins";
import { buildPluginStack } from "../plugins/testing";
import { providerAccountRepository, type StoredProviderAccount } from "../provider-accounts";
import { Settings, SettingsLayer } from "../settings";
import { TextGenerationModels, TextGenerationModelsLayer } from "./models";
import {
  addFixtureAccount,
  addSnapshot,
  addTextGenerationRunner,
  buildProbeResult as probed,
  buildTextGenerationPlugins,
  type RunnerTraits,
} from "./testing";

const layer = TextGenerationModelsLayer.pipe(
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(buildPluginStack()),
);

/** An account of each automatic provider, arranged by `run`. */
interface Fleet {
  readonly openai: StoredProviderAccount;
  readonly zai: StoredProviderAccount;
  readonly anthropic: StoredProviderAccount;
  readonly addRunner: (traits?: RunnerTraits) => Effect.Effect<string, never, SqlClient.SqlClient>;
  /** Stores a snapshot of an account in its own default harness. */
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
    Settings | TextGenerationModels | SqlClient.SqlClient | PluginHost
  >,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
      return yield* arrange({
        openai: yield* addFixtureAccount("openai"),
        zai: yield* addFixtureAccount("zai"),
        anthropic: yield* addFixtureAccount("anthropic"),
        addRunner: (traits) => Effect.orDie(addTextGenerationRunner(traits)),
        snapshot: (account, runner, result) =>
          Effect.orDie(addSnapshot(account.id, account.defaultHarnessId, runner, result)),
      });
    }).pipe(Effect.orDie, Effect.provide(layer)),
  );

const resolve = Effect.flatMap(TextGenerationModels, (models) => models.resolve());

describe("automatic", () => {
  it("picks the first provider, in the fixed order, whose suggested model a signed-in runner offers", async () => {
    const target = await run(({ openai, zai, anthropic, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "something-else"));
        yield* snapshot(zai, runner, probed("ok", "pi-small"));
        yield* snapshot(anthropic, runner, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      accountName: "Z.ai",
      harnessId: "pi/pi",
      model: "pi-small",
      runnerIds: [expect.any(String) as unknown],
    });
  });

  it("takes the oldest account of the provider that is signed in, and skips an older one that is not", async () => {
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
          probed("unauthenticated", "codex-mini"),
        );
        yield* addSnapshot(newer.id, newer.defaultHarnessId, runner, probed("ok", "codex-mini"));
        yield* addSnapshot(older.id, older.defaultHarnessId, runner, probed("ok", "codex-mini"));
        return { target: yield* resolve, olderId: older.id };
      }).pipe(Effect.orDie, Effect.provide(layer)),
    );

    expect(target.target).toMatchObject({
      _tag: "resolved",
      providerAccountId: target.olderId,
      accountName: "OpenAI · older",
    });
  });

  it("skips a login that expired and a snapshot on a reserved runner", async () => {
    const target = await run(({ openai, zai, anthropic, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const open = yield* addRunner();
        const reserved = yield* addRunner({ reserved: true });
        yield* snapshot(openai, open, probed("unauthenticated", "codex-mini"));
        yield* snapshot(zai, reserved, probed("ok", "pi-small"));
        yield* snapshot(anthropic, open, probed("ok", "haiku"));
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      harnessId: "claude-code/claude-code",
      model: "haiku",
    });
  });

  it("skips an account that is signed in only on an offline runner", async () => {
    const target = await run(({ openai, zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const offline = yield* addRunner({ online: false });
        const online = yield* addRunner();
        yield* snapshot(openai, offline, probed("ok", "codex-mini"));
        yield* snapshot(zai, online, probed("ok", "pi-small"));
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
        yield* snapshot(openai, old, probed("ok", "codex-mini"));
        yield* snapshot(zai, current, probed("ok", "pi-small"));
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
          yield* snapshot(openai, runner, probed("ok", "codex-mini"));
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
        yield* snapshot(openai, runner, probed("ok", "codex-mini"));
        yield* snapshot(zai, runner, probed("ok", "pi-small"));
        const withOpenai = yield* resolve.pipe(Effect.orDie);
        yield* snapshot(openai, runner, probed("unauthenticated", "codex-mini"));
        const withZai = yield* resolve.pipe(Effect.orDie);
        yield* snapshot(zai, runner, probed("unauthenticated", "pi-small"));
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
      message: expect.stringContaining("signed in that offers a suggested") as unknown,
    });
  });

  it("is what an unset setting means", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* inTransaction(settings.set("textGeneration.model", "automatic"));
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "codex-mini"));
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
  it("is returned as it is, with no runner, when no runner offers the model", async () => {
    const target = await run(({ zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(zai, runner, probed("ok", "pi-small"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: zai.id,
            model: "not-in-any-catalog",
          }),
        );
        return yield* resolve.pipe(Effect.orDie);
      }),
    );

    expect(target).toMatchObject({
      _tag: "resolved",
      accountName: "Z.ai",
      harnessId: "pi/pi",
      model: "not-in-any-catalog",
      runnerIds: [],
    });
  });

  it("runs in the account's default harness when the choice names none, and in the named harness otherwise", async () => {
    const targets = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "codex-mini"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            model: "codex-mini",
          }),
        );
        const byDefault = yield* resolve.pipe(Effect.orDie);
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            harnessId: "codex/codex",
            model: "codex-mini",
          }),
        );
        return { byDefault, named: yield* resolve.pipe(Effect.orDie) };
      }),
    );

    expect(targets.byDefault).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
    expect(targets.named).toMatchObject({ _tag: "resolved", harnessId: "codex/codex" });
  });

  it("lists only the runners that can take the call and list the model", async () => {
    const [target, expected] = await run(({ zai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const offers = yield* addRunner();
        const lacksModel = yield* addRunner();
        const offline = yield* addRunner({ online: false });
        const old = yield* addRunner({ capable: false });
        yield* snapshot(zai, offers, probed("ok", "pi-small"));
        yield* snapshot(zai, lacksModel, probed("ok", "pi-large"));
        yield* snapshot(zai, offline, probed("ok", "pi-small"));
        yield* snapshot(zai, old, probed("ok", "pi-small"));
        yield* inTransaction(
          settings.set("textGeneration.model", { providerAccountId: zai.id, model: "pi-small" }),
        );
        return [yield* resolve.pipe(Effect.orDie), [offers]] as const;
      }),
    );

    expect(target).toMatchObject({ _tag: "resolved", runnerIds: expected });
  });

  it("is unresolved, naming the account, when the account cannot run in the chosen harness", async () => {
    const target = await run(({ openai, addRunner, snapshot }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const runner = yield* addRunner();
        yield* snapshot(openai, runner, probed("ok", "codex-mini"));
        yield* inTransaction(
          settings.set("textGeneration.model", {
            providerAccountId: openai.id,
            harnessId: "pi/pi",
            model: "codex-mini",
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
        yield* snapshot(openai, runner, probed("ok", "codex-mini"));
        yield* inTransaction(
          settings.set("textGeneration.model", { providerAccountId: zai.id, model: "pi-small" }),
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
