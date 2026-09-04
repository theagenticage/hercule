import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { Settings, SettingsLayer } from "./repository";

const layer = SettingsLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, Settings | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** Runs an effect that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Settings | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));

const ALICE = "0199e0e7-0000-7000-8000-000000000000";
const BOB = "0199e0e7-0001-7000-8000-000000000000";

/** A row the `user_settings` foreign key can point at. */
const addUser = (id: string, username: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES (${uuidFromString(id)}, ${username}, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `,
  );

describe("Settings", () => {
  it("round trips a typed value", async () => {
    const [days, time] = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.setIfAbsent("retention.events", 30);
        yield* settings.setIfAbsent("backup.time", "23:45");
        return [
          yield* settings.get("retention.events"),
          yield* settings.get("backup.time"),
        ] as const;
      }),
    );
    expect(days).toBe(30);
    expect(time).toBe("23:45");
  });

  it("fails on a key nobody has set", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) => settings.get("backup.keep")),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a value the key's schema rejects", async () => {
    const error = await runError(
      Effect.flatMap(Settings, (settings) => settings.setIfAbsent("backup.time", "25:00")),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("refuses a retention window that is not a positive whole number of days", async () => {
    for (const bad of [0, -1, 1.5]) {
      const error = await runError(
        Effect.flatMap(Settings, (settings) => settings.setIfAbsent("retention.security", bad)),
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
        return yield* settings.get("backup.keep");
      }),
    );
    expect(error._tag).toBe("SettingError");
  });

  it("leaves an existing value alone when a default is seeded over it", async () => {
    const value = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.setIfAbsent("retention.events", 7);
        yield* settings.setIfAbsent("retention.events", 90);
        return yield* settings.get("retention.events");
      }),
    );
    expect(value).toBe(7);
  });

  it("keeps one user's settings apart from another's", async () => {
    const [mine, theirs, all] = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* addUser(ALICE, "alice");
        yield* addUser(BOB, "bob");
        yield* settings.setForUser(ALICE, "timezone", "Europe/Amsterdam");
        yield* settings.setForUser(BOB, "timezone", "UTC");
        return [
          yield* settings.getForUser(ALICE, "timezone"),
          yield* settings.getForUser(BOB, "timezone"),
          yield* settings.allForUser(ALICE),
        ] as const;
      }),
    );
    expect(mine).toBe("Europe/Amsterdam");
    expect(theirs).toBe("UTC");
    expect(all).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("does not answer one user's read with another user's rows", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* addUser(ALICE, "alice");
        yield* addUser(BOB, "bob");
        yield* settings.setForUser(ALICE, "timezone", "Europe/Amsterdam");
        return yield* settings.getForUser(BOB, "timezone");
      }),
    );
    expect(error._tag).toBe("SettingError");
  });
});
