import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "./db/testing";
import { PermissionProfiles, PermissionProfilesLayer } from "./permissions";
import { Settings, SettingsLayer } from "./settings";
import { seed } from "./seed";

const layer = Layer.mergeAll(SettingsLayer, PermissionProfilesLayer).pipe(
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Settings | PermissionProfiles | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const readProfileByName = (name: string) =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const profile = yield* profiles.getByName(name);
    return Option.getOrThrow(profile);
  });

/**
 * The shipped profiles, listed in full so a change to the seeded grants shows
 * up here as a failing test rather than as drift.
 */
describe("the shipped permission profiles", () => {
  it("seeds assistant with the orchestration surface plus read on everything but secrets", async () => {
    const profile = await run(Effect.flatMap(seed, () => readProfileByName("assistant")));
    expect([...profile.grants].sort()).toEqual(
      [
        "task.read",
        "task.create",
        "task.update",
        "task.delete",
        "workflow.read",
        "workflow.run",
        "workflow.submit",
        "run.read",
        "run.write",
        "session.read",
        "session.spawn",
        "session.steer",
        "subscription.read",
        "subscription.write",
        "notification.read",
        "notification.write",
        "event.read",
        "event.emit",
        "memory.read",
        "memory.write",
        "settings.read",
        "connection.read",
        "infra.read",
        "workspace.read",
        "agent.read",
        "permission.read",
        "project.read",
        "resource.read",
      ].sort(),
    );
    expect(profile.shipped).toBe(true);
    // An assistant reads the log, but not the security entries in it.
    expect(profile.grants).not.toContain("event.audit");
  });

  it("seeds worker with the trust floor for workflow agent steps", async () => {
    const profile = await run(Effect.flatMap(seed, () => readProfileByName("worker")));
    expect([...profile.grants].sort()).toEqual(
      [
        "task.read",
        "task.create",
        "task.update",
        // A worker reads as well as writes notifications: without the read
        // grant it could not read back the ones it creates.
        "notification.read",
        "notification.write",
        "subscription.read",
        "subscription.write",
        "run.read",
        "event.read",
      ].sort(),
    );
    expect(profile.grants).not.toContain("task.delete");
    expect(profile.grants).not.toContain("session.spawn");
    expect(profile.grants).not.toContain("session.read");
    expect(profile.grants).not.toContain("workflow.run");
    expect(profile.grants).not.toContain("workflow.submit");
    expect(profile.grants).not.toContain("memory.read");
    expect(profile.grants).not.toContain("memory.write");
    expect(profile.grants).not.toContain("event.audit");
  });

  it("seeds unrestricted at user parity, withholding nothing", async () => {
    const [unrestricted, assistant] = await run(
      Effect.flatMap(seed, () =>
        Effect.all([readProfileByName("unrestricted"), readProfileByName("assistant")] as const),
      ),
    );
    for (const grant of assistant.grants) expect(unrestricted.grants).toContain(grant);
    expect(unrestricted.grants).toContain("secret.write");
    expect(unrestricted.grants).toContain("credential.write");
    expect(unrestricted.grants).toContain("infra.write");
    expect(unrestricted.grants).toContain("permission.write");
    // Parity includes the security entries of the event log.
    expect(unrestricted.grants).toContain("event.audit");
  });

  it("seeds exactly three profiles, all marked shipped", async () => {
    const profiles = await run(
      Effect.flatMap(seed, () =>
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ readonly name: string; readonly shipped: number }>`
            SELECT name, shipped FROM permission_profiles ORDER BY name
          `,
        ),
      ),
    );
    expect(profiles.map((profile) => profile.name)).toEqual([
      "assistant",
      "unrestricted",
      "worker",
    ]);
    expect(profiles.every((profile) => profile.shipped === 1)).toBe(true);
  });
});

describe("the controller settings defaults", () => {
  it("seeds the retention windows and the backup schedule", async () => {
    const values = await run(
      Effect.flatMap(seed, () =>
        Effect.gen(function* () {
          const settings = yield* Settings;
          return {
            events: yield* settings.get("retention.events"),
            security: yield* settings.get("retention.security"),
            conversations: yield* settings.get("retention.conversations"),
            time: yield* settings.get("backup.time"),
            keep: yield* settings.get("backup.keep"),
          };
        }),
      ),
    );
    expect(values).toEqual({
      events: 90,
      security: 90,
      conversations: 90,
      time: "03:30",
      keep: 14,
    });
  });

  it("seeds no user-scope rows: no user exists until setup completes", async () => {
    const rows = await run(
      Effect.flatMap(seed, () =>
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`SELECT key FROM settings WHERE scope = 'user'`,
        ),
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe("seeding twice", () => {
  const snapshot = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const profiles = yield* sql<{
      readonly name: string;
      readonly grants: string;
      readonly updated_at: string;
    }>`SELECT name, grants, updated_at FROM permission_profiles ORDER BY name`;
    const settings = yield* sql<{
      readonly key: string;
      readonly value: string;
      readonly updated_at: string;
    }>`SELECT key, value, updated_at FROM settings ORDER BY scope, key`;
    return { profiles, settings };
  });

  it("changes nothing", async () => {
    const [first, second] = await run(
      Effect.gen(function* () {
        yield* seed;
        const first = yield* snapshot;
        yield* seed;
        return [first, yield* snapshot] as const;
      }),
    );
    expect(second).toEqual(first);
    expect(first.profiles).toHaveLength(3);
    expect(first.settings).toHaveLength(5);
  });

  it("leaves an edited shipped profile and an edited setting alone", async () => {
    const [profile, retention] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* Settings;
        yield* seed;
        yield* sql`UPDATE permission_profiles SET grants = '["task.read"]' WHERE name = 'worker'`;
        yield* sql`UPDATE settings SET value = '7' WHERE scope = 'controller' AND key = 'retention.events'`;
        yield* seed;
        return [
          yield* readProfileByName("worker"),
          yield* settings.get("retention.events"),
        ] as const;
      }),
    );
    expect(profile.grants).toEqual(["task.read"]);
    expect(profile.shipped).toBe(true);
    expect(retention).toBe(7);
  });
});
