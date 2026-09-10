import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { Settings, SettingsLayer } from "./repository";
import { SettingsOperations, SettingsOperationsLayer } from "./service";

type Deps = SettingsOperations | Settings | AuditLog | SqlClient.SqlClient;

const layer = SettingsOperationsLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER_ID = "0199e0e7-0000-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: USER_ID,
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** The row the user settings foreign key points at; the boot writes it at setup. */
const addUser = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    INSERT INTO users (id, username, password_hash, created_at, updated_at)
    VALUES (${uuidFromString(USER_ID)}, 'rogier', 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `,
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.andThen(addUser, effect).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
    ),
  );

/** Runs a call made by nobody: an in-process caller with no credential. */
const runAnonymous = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(Effect.andThen(addUser, effect).pipe(Effect.flip, Effect.provide(layer)));

describe("settings.read", () => {
  it("answers with the keys that are set, and nothing for the rest", async () => {
    const state = await run(
      Effect.gen(function* () {
        const store = yield* Settings;
        yield* store.set("retention.events", 30);
        yield* store.setForUser(USER_ID, "timezone", "Europe/Amsterdam");
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

  it("refuses a patch that names no key, and writes no audit row", async () => {
    const error = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const audit = yield* AuditLog;
        const failure = yield* Effect.flip(settings.update({}));
        expect(yield* audit.listByKind("settings.updated")).toEqual([]);
        return failure;
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a patch whose scopes are empty objects", async () => {
    const error = await run(
      Effect.flatMap(SettingsOperations, (settings) =>
        Effect.flip(settings.update({ controller: {}, user: {} })),
      ),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("writes the user scope under the caller's own id", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const sql = yield* SqlClient.SqlClient;
        yield* settings.update({ user: { timezone: "UTC" } });
        return yield* sql<{
          readonly key: string;
        }>`SELECT key FROM user_settings WHERE user_id = ${uuidFromString(USER_ID)}`;
      }),
    );
    expect(rows).toEqual([{ key: "timezone" }]);
  });

  it("writes a thread row density and reads it back", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ user: { "ui.threadRows": "plain" } });
        return yield* settings.read();
      }),
    );
    expect(state.user).toEqual({ "ui.threadRows": "plain" });
  });

  it("refuses a thread row density outside the two the shell offers", async () => {
    const error = await run(
      Effect.flatMap(SettingsOperations, (settings) =>
        Effect.flip(settings.update({ user: { "ui.threadRows": "rich" } as never })),
      ),
    );
    expect(error).toMatchObject({ _tag: "SettingError", scope: "user", key: "ui.threadRows" });
  });

  it("writes both session timeouts in whole minutes and reads them back", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({
          controller: { "session.inactivityTimeout": 5, "session.absoluteTimeout": 60 },
        });
        return yield* settings.read();
      }),
    );
    expect(state.controller).toEqual({
      "session.inactivityTimeout": 5,
      "session.absoluteTimeout": 60,
    });
  });

  it("refuses a session timeout that is zero or not a whole number of minutes", async () => {
    // A session may not be given no time at all, and a fraction of a minute is
    // not something the wire's milliseconds can be derived from honestly.
    for (const key of ["session.inactivityTimeout", "session.absoluteTimeout"] as const) {
      for (const value of [0, -1, 1.5]) {
        const error = await run(
          Effect.flatMap(SettingsOperations, (settings) =>
            Effect.flip(settings.update({ controller: { [key]: value } })),
          ),
        );
        expect(error, `${key} = ${String(value)}`).toMatchObject({
          _tag: "SettingError",
          scope: "controller",
          key,
        });
      }
    }
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
