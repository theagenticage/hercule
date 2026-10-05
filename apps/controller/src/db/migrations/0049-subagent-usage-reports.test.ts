/** Checks that existing subagents have no saved report and that accepted reports round-trip. */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { uuidFromString } from "../id";
import { runMigrations } from "../migrate";
import { subagentRepository } from "../../sessions/subagent-repository";
import { migrations } from "./index";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";
const AT = "2026-10-06T00:00:00.000Z";
const BEFORE = migrations.filter(([id]) => id < 49);

describe("the saved subagent usage report migration", () => {
  it("leaves existing rows without a report, preserves reports unchanged, and clears them", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO sessions
        (id, permission_profile_id, instance_id, runner_id, requested_access_mode, access_mode,
         spec, title, status, created_at, last_activity_at)
        VALUES (${uuidFromString(SESSION)}, x'00', x'00', x'00', 'auto', 'auto', '{}',
                'a session', 'queued', ${AT}, ${AT})`;
        yield* sql`INSERT INTO session_subagents
        (session_id, subagent_id, status, started_at)
        VALUES (${uuidFromString(SESSION)}, 'a1', 'completed', ${AT})`;
        yield* runMigrations();
        const [migrated] = yield* sql<{ readonly last_usage_report: string | null }>`
        SELECT last_usage_report FROM session_subagents`;
        const repository = yield* subagentRepository;
        const record = Option.getOrThrow(yield* repository.one(SESSION, "a1"));
        const lastUsageReport = {
          source: "test.provider",
          payload: { total: [100, 80, 3], detail: { unchanged: true } },
        };
        yield* repository.save({ ...record, lastUsageReport });
        const restored = Option.getOrThrow(yield* repository.one(SESSION, "a1"));
        yield* repository.save({ ...restored, lastUsageReport: undefined });
        const cleared = Option.getOrThrow(yield* repository.one(SESSION, "a1"));
        const invalid = yield* Effect.exit(
          sql`UPDATE session_subagents SET last_usage_report = 'not JSON'`,
        );
        return {
          migrated,
          restored: restored.lastUsageReport,
          cleared: cleared.lastUsageReport,
          invalid: invalid._tag,
        };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result.migrated).toEqual({ last_usage_report: null });
    expect(result.restored).toEqual({
      source: "test.provider",
      payload: { total: [100, 80, 3], detail: { unchanged: true } },
    });
    expect(result.cleared).toBeUndefined();
    expect(result.invalid).toBe("Failure");
  });
});
