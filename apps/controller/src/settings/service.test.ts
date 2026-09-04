import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { Settings, SettingsLayer } from "./repository";
import { SettingsOperations, SettingsOperationsLayer } from "./service";

type Deps = SettingsOperations | Settings | AuditLog;

const layer = SettingsOperationsLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)));

/** Runs a call made by nobody: an in-process caller with no credential. */
const runAnonymous = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));

describe("settings.read", () => {
  it("answers with the keys that are set, and nothing for the rest", async () => {
    const state = await run(
      Effect.gen(function* () {
        const store = yield* Settings;
        yield* store.set("controller", "retention.events", 30);
        yield* store.set("user", "timezone", "Europe/Amsterdam");
        return yield* Effect.flatMap(SettingsOperations, (settings) => settings.read());
      }),
    );
    expect(state).toEqual({
      controller: { "retention.events": 30 },
      user: { timezone: "Europe/Amsterdam" },
    });
  });

  it("answers with two empty scopes on a store nobody has written", async () => {
    const state = await run(Effect.flatMap(SettingsOperations, (settings) => settings.read()));
    expect(state).toEqual({ controller: {}, user: {} });
  });

  it("refuses a caller with no credential, before reading anything", async () => {
    const error = await runAnonymous(
      Effect.flatMap(SettingsOperations, (settings) => settings.read()),
    );
    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "settings.read" } },
    });
  });
});

describe("settings.update", () => {
  it("writes the keys it names, leaves the rest alone, and answers with the whole state", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ controller: { "backup.keep": 14 } });
        return yield* settings.update({
          user: { timezone: "UTC", "topics.order": ["intake", "checkin"] },
        });
      }),
    );
    expect(state).toEqual({
      controller: { "backup.keep": 14 },
      user: { timezone: "UTC", "topics.order": ["intake", "checkin"] },
    });
  });

  it("replaces a key that is already set", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ user: { timezone: "UTC" } });
        return yield* settings.update({ user: { timezone: "Europe/Amsterdam" } });
      }),
    );
    expect(state.user).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("stamps the keys it wrote, and never their values", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const audit = yield* AuditLog;
        yield* settings.update({
          controller: { "backup.time": "03:30" },
          user: { timezone: "UTC" },
        });
        return yield* audit.listByKind("settings.updated");
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(entries[0]?.payload).toEqual({
      keys: [
        { scope: "controller", key: "backup.time" },
        { scope: "user", key: "timezone" },
      ],
    });
    expect(JSON.stringify(entries[0]?.payload)).not.toContain("03:30");
  });

  it("writes nothing when the caller may not write", async () => {
    const error = await runAnonymous(
      Effect.flatMap(SettingsOperations, (settings) =>
        settings.update({ user: { timezone: "UTC" } }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });

    const state = await run(Effect.flatMap(SettingsOperations, (settings) => settings.read()));
    expect(state.user).toEqual({});
  });
});
