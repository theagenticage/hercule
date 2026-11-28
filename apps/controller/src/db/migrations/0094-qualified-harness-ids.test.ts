/**
 * Tests what the qualified harness ids migration does to rows written by the
 * previous head: the three bare harness ids become qualified in Provider
 * Instances and in a runner's facts, a stored event's `providerRefs` key is
 * renamed `harnessRefs`, and everything else in those rows stays as it was.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 94);

/**
 * The migrations up to and including the one under test. Migration 95 drops
 * `provider_instances` and refuses the made-up harness this test stores, so
 * the test stops at 94.
 */
const UP_TO_QUALIFIED_HARNESS_IDS = migrations.filter(([id]) => id <= 94);

const at = "2026-10-30T00:00:00.000Z";
const SESSION = new Uint8Array(16).fill(7);

/** The harness binaries a runner found, as the old facts called them `providers`. */
const BINARIES = [
  { name: "claude", present: true, path: "/usr/bin/claude" },
  { name: "codex", present: false },
];

/** A runner's facts as the previous head stored them, with every other field set. */
const OLD_FACTS = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 17179869184,
  docker: true,
  toolchains: [{ name: "node", version: "22.1.0" }],
  providers: BINARIES,
  adapters: ["codex", "claude-code", "pi", "future-harness", "claude-code/claude-code"],
  identityPort: 8080,
};

/** The facts after the migration: `providers` renamed, the three bare adapters qualified. */
const NEW_FACTS = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 17179869184,
  docker: true,
  toolchains: [{ name: "node", version: "22.1.0" }],
  harnesses: BINARIES,
  adapters: [
    "codex/codex",
    "claude-code/claude-code",
    "pi/pi",
    "future-harness",
    "claude-code/claude-code",
  ],
  identityPort: 8080,
};

/** The stored events: what each one is called here, and its JSON as the previous head wrote it. */
const EVENTS = {
  started: {
    _tag: "session.started",
    eventId: "e1",
    providerRefs: { nativeSessionId: "native-1" },
    raw: { source: "claude/providerRefs" },
  },
  plain: { _tag: "turn.started", eventId: "e2", turnId: "t1" },
  nested: {
    _tag: "item.completed",
    eventId: "e3",
    detail: { providerRefs: { nativeSessionId: "inside-a-payload" } },
    text: 'the word "providerRefs" in a message',
  },
} as const;

interface Migrated {
  readonly instances: ReadonlyArray<{ readonly name: string; readonly provider_id: string }>;
  readonly runners: ReadonlyMap<string, unknown>;
  readonly events: ReadonlyMap<string, unknown>;
}

const seedAndMigrate = (): Promise<Migrated> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);

      yield* Effect.forEach(
        [
          ["claude", "claude-code"],
          ["codex", "codex"],
          ["pi", "pi"],
          ["unknown", "future-harness"],
          ["qualified", "codex/codex"],
        ] as const,
        ([name, providerId], index) =>
          sql`INSERT INTO provider_instances (id, provider_id, name, config, created_at, updated_at)
              VALUES (${new Uint8Array(16).fill(index + 1)}, ${providerId}, ${name}, '{}', ${at}, ${at})`,
        { discard: true },
      );

      yield* Effect.forEach(
        [
          ["with-facts", JSON.stringify(OLD_FACTS)],
          ["never-connected", null],
        ] as const,
        ([name, facts], index) =>
          sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                   credential_hash, facts, created_at, updated_at)
              VALUES (${new Uint8Array(16).fill(index + 1)}, ${name}, 'offline', 'active', 0, '[]',
                      ${`hash-${name}`}, ${facts}, ${at}, ${at})`,
        { discard: true },
      );

      yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                       requested_access_mode, access_mode, spec, title, status,
                                       created_at, last_activity_at)
                 VALUES (${SESSION}, x'00', x'00', x'00', 'auto', 'auto', '{}', 'a session',
                         'exited', ${at}, ${at})`;
      yield* Effect.forEach(
        Object.values(EVENTS),
        (event, index) =>
          sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
              VALUES (${SESSION}, ${index + 1}, ${index + 1}, ${at}, ${JSON.stringify(event)})`,
        { discard: true },
      );
      // An event from a build that wrote its JSON with spaces after the colons.
      yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
                 VALUES (${SESSION}, 4, 4, ${at}, '{"_tag": "x", "providerRefs": {"nativeSessionId": "spaced"}}')`;

      yield* runMigrations(UP_TO_QUALIFIED_HARNESS_IDS);

      const instances = yield* sql<{
        readonly name: string;
        readonly provider_id: string;
      }>`SELECT name, provider_id FROM provider_instances ORDER BY id`;
      const runners = yield* sql<{
        readonly name: string;
        readonly facts: string | null;
      }>`SELECT name, facts FROM runners`;
      const events = yield* sql<{
        readonly position: number;
        readonly event: string;
      }>`SELECT position, event FROM session_stream ORDER BY position`;
      return {
        instances,
        runners: new Map(
          runners.map((row) => [row.name, row.facts === null ? null : JSON.parse(row.facts)]),
        ),
        events: new Map(events.map((row) => [String(row.position), JSON.parse(row.event)])),
      };
    }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
  );

describe("the qualified harness ids migration", () => {
  // Seeding and migrating is the slow part and the tests only read the result,
  // so it runs once.
  let migrated: Migrated;
  beforeAll(async () => {
    migrated = await seedAndMigrate();
  });

  it("qualifies the three bare ids on Provider Instances and leaves any other id", () => {
    const { instances } = migrated;
    expect(instances.map((row) => [row.name, row.provider_id])).toEqual([
      ["claude", "claude-code/claude-code"],
      ["codex", "codex/codex"],
      ["pi", "pi/pi"],
      ["unknown", "future-harness"],
      ["qualified", "codex/codex"],
    ]);
  });

  it("renames `providers` to `harnesses` in a runner's facts, qualifies its adapters, and keeps every other field", () => {
    const { runners } = migrated;
    // The order of `adapters` is not promised, and nothing reads it: the
    // controller only checks whether the list includes an id. So the list is
    // compared sorted, and the other fields as they are.
    const { adapters: migratedAdapters, ...migratedRest } = runners.get("with-facts") as {
      readonly adapters: ReadonlyArray<string>;
    };
    const { adapters: expectedAdapters, ...expectedRest } = NEW_FACTS;
    expect(migratedRest).toEqual(expectedRest);
    expect([...migratedAdapters].sort()).toEqual([...expectedAdapters].sort());
  });

  it("leaves a runner that never reported facts without facts", () => {
    const { runners } = migrated;
    expect(runners.get("never-connected")).toBeNull();
  });

  it("renames a top-level `providerRefs` and keeps its value", () => {
    const { events } = migrated;
    expect(events.get("1")).toEqual({
      _tag: "session.started",
      eventId: "e1",
      harnessRefs: { nativeSessionId: "native-1" },
      raw: { source: "claude/providerRefs" },
    });
    expect(events.get("4")).toEqual({
      _tag: "x",
      harnessRefs: { nativeSessionId: "spaced" },
    });
  });

  it("leaves events without the key and a key nested inside a payload as they were", () => {
    const { events } = migrated;
    expect(events.get("2")).toEqual(EVENTS.plain);
    expect(events.get("3")).toEqual(EVENTS.nested);
  });
});
