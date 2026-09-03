import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { Settings, SettingsLayer } from "./settings";

const layer = SettingsLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, Settings | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** Runs an effect that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Settings | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));

describe("Settings", () => {
  it("round trips a typed value", async () => {
    const [days, time] = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("controller", "retention.events", 30);
        yield* settings.set("controller", "backup.time", "23:45");
        return [
          yield* settings.get("controller", "retention.events"),
          yield* settings.get("controller", "backup.time"),
        ] as const;
      }),
    );
    expect(days).toBe(30);
    expect(time).toBe("23:45");
  });

  it("replaces an existing value", async () => {
    const value = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("controller", "backup.keep", 14);
        yield* settings.set("controller", "backup.keep", 7);
        return yield* settings.get("controller", "backup.keep");
      }),
    );
    expect(value).toBe(7);
  });

  it("fails on a key nobody has set", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) => settings.get("controller", "backup.keep")),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a value the key's schema rejects", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) => settings.set("controller", "backup.time", "25:00")),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a retention window that is not a positive whole number of days", async () => {
    for (const bad of [0, -1, 1.5]) {
      const error = await runError(
        Effect.flatMap(Settings, (settings) =>
          settings.set("controller", "retention.security", bad),
        ),
      );
      expect(error._tag).toBe("SettingError");
    }
  });

  it("keeps the two scopes apart and lists one scope", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("controller", "backup.keep", 14);
        yield* settings.set("controller", "backup.time", "03:30");
        return {
          controller: yield* settings.list("controller"),
          user: yield* settings.list("user"),
        };
      }),
    );
    expect(rows.controller.map((row) => row.key)).toEqual(["backup.keep", "backup.time"]);
    expect(rows.user).toEqual([]);
  });

  it("leaves an existing value alone when a default is seeded over it", async () => {
    const value = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.set("controller", "retention.events", 7);
        yield* settings.setIfAbsent("controller", "retention.events", 90);
        return yield* settings.get("controller", "retention.events");
      }),
    );
    expect(value).toBe(7);
  });
});
