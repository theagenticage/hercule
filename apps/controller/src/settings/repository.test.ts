import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { Settings, SettingsLayer } from "./repository";

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
        yield* settings.setIfAbsent("controller", "retention.events", 30);
        yield* settings.setIfAbsent("controller", "backup.time", "23:45");
        return [
          yield* settings.get("controller", "retention.events"),
          yield* settings.get("controller", "backup.time"),
        ] as const;
      }),
    );
    expect(days).toBe(30);
    expect(time).toBe("23:45");
  });

  it("fails on a key nobody has set", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) => settings.get("controller", "backup.keep")),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a value the key's schema rejects", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) =>
        settings.setIfAbsent("controller", "backup.time", "25:00"),
      ),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a retention window that is not a positive whole number of days", async () => {
    for (const bad of [0, -1, 1.5]) {
      const error = await runError(
        Effect.flatMap(Settings, (settings) =>
          settings.setIfAbsent("controller", "retention.security", bad),
        ),
      );
      expect(error._tag).toBe("SettingError");
    }
  });

  it("fails to read a stored value its schema rejects", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* Settings;
        yield* sql`
          INSERT INTO settings (scope, key, value, updated_at)
          VALUES ('controller', 'backup.keep', '"fourteen"', '2026-01-01T00:00:00.000Z')
        `;
        return yield* settings.get("controller", "backup.keep");
      }),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("leaves an existing value alone when a default is seeded over it", async () => {
    const value = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.setIfAbsent("controller", "retention.events", 7);
        yield* settings.setIfAbsent("controller", "retention.events", 90);
        return yield* settings.get("controller", "retention.events");
      }),
    );
    expect(value).toBe(7);
  });
});
