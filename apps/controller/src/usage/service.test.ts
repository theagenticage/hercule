/**
 * Tests Account Usage on a real database: readings are ordered by the time
 * they were taken, and an active read is claimed at most every 15 minutes.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import type { UsageReading } from "@hercule/protocol";
import { mintUuid, uuidToString, uuidFromString } from "../db";
import { buildAnnouncementRecorder, inTransaction, TestDatabase } from "../db/testing";
import { AccountUsage, AccountUsageLayer } from "./index";

const NOW = "2026-10-31T12:00:00.000Z";

/** Returns the instant `minutes` before or after `NOW` (negative is before). */
const minutesFromNow = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

const windowReading = (
  window: "five-hour" | "weekly",
  usedPercent: number,
  takenAt: string,
): UsageReading => ({ kind: "window", window, usedPercent, resetsAt: null, hit: false, takenAt });

const fiveHour = (usedPercent: number, takenAt: string) =>
  windowReading("five-hour", usedPercent, takenAt);

const weekly = (usedPercent: number, takenAt: string) =>
  windowReading("weekly", usedPercent, takenAt);

const credit = (remaining: number, takenAt: string): UsageReading => ({
  kind: "credit",
  remaining,
  limit: null,
  takenAt,
});

/** Runs an effect with the controller's clock held at `NOW` and returns it with the announcements. */
const setup = () => {
  const recorder = buildAnnouncementRecorder();
  const layer = AccountUsageLayer.pipe(
    Layer.provideMerge(recorder.listener),
    Layer.provideMerge(TestDatabase),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, AccountUsage | SqlClient.SqlClient>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        return yield* effect;
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    );
  return { run, announced: recorder.announced };
};

/** Inserts a Provider Account row, which the usage tables reference, and returns its id. */
const addAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = mintUuid();
  yield* inTransaction(sql`
    INSERT INTO provider_accounts
      (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
    VALUES (${id}, 'acme/acme', 'api-key', ${uuidToString(id)}, 'alpha/alpha', ${NOW}, ${NOW})
  `);
  return uuidToString(id);
});

const deleteAccount = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    inTransaction(sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(id)}`),
  );

const countRows = (table: "account_usage_readings" | "account_usage_reads") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
      (rows) => rows[0]!.n,
    ),
  );

describe("recording readings", () => {
  const { run } = setup();

  it("keeps the reading that was taken last, whatever order the readings arrive in", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-10))], "read");
        const older = yield* accountUsage.record(id, [fiveHour(10, minutesFromNow(-30))], "read");
        const afterOlder = yield* accountUsage.read(id);
        const newer = yield* accountUsage.record(id, [fiveHour(60, minutesFromNow(-5))], "session");
        return { older, newer, afterOlder, final: yield* accountUsage.read(id) };
      }),
    );
    expect(usage.older).toBe(false);
    expect(usage.afterOlder).toMatchObject([{ usedPercent: 40, source: "read" }]);
    expect(usage.newer).toBe(true);
    expect(usage.final).toMatchObject([{ usedPercent: 60, source: "session" }]);
  });

  it("stores a reading dated in the future as taken now, so a later real reading replaces it", async () => {
    const [afterFuture, afterReal] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(60))], "session");
        const afterFuture = yield* accountUsage.read(id);
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(45, minutesFromNow(1))], "read");
        return [afterFuture, yield* accountUsage.read(id)] as const;
      }),
    );
    expect(afterFuture).toMatchObject([{ usedPercent: 40, takenAt: NOW }]);
    expect(afterReal).toMatchObject([{ usedPercent: 45, takenAt: minutesFromNow(1) }]);
  });

  it("keeps the stored reading when a reading is taken at the same time", async () => {
    const [changed, stored] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        const changed = yield* accountUsage.record(id, [fiveHour(55, NOW)], "session");
        return [changed, yield* accountUsage.read(id)] as const;
      }),
    );
    expect(changed).toBe(false);
    expect(stored).toMatchObject([{ usedPercent: 40, source: "read" }]);
  });

  it("orders each window and the credit on their own", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(
          id,
          [credit(5, minutesFromNow(-1)), weekly(70, minutesFromNow(-1))],
          "read",
        );
        // Newer for the five-hour window, older for the weekly window and the credit.
        yield* accountUsage.record(
          id,
          [credit(9, minutesFromNow(-20)), fiveHour(20, NOW), weekly(30, minutesFromNow(-20))],
          "session",
        );
        return yield* accountUsage.read(id);
      }),
    );
    expect(stored).toMatchObject([
      { kind: "window", window: "five-hour", usedPercent: 20, source: "session" },
      { kind: "window", window: "weekly", usedPercent: 70, source: "read" },
      { kind: "credit", remaining: 5, source: "read" },
    ]);
  });

  it("reads every account's readings in one call, each list in window order", async () => {
    const all = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const first = yield* addAccount;
        const second = yield* addAccount;
        const none = yield* addAccount;
        yield* accountUsage.record(
          first,
          [credit(5, NOW), weekly(1, NOW), fiveHour(2, NOW)],
          "read",
        );
        yield* accountUsage.record(second, [weekly(3, NOW)], "read");
        const all = yield* accountUsage.readAll();
        return { all, first, second, none };
      }),
    );
    expect(
      all.all
        .get(all.first)
        ?.map((reading) => (reading.kind === "credit" ? "credit" : reading.window)),
    ).toEqual(["five-hour", "weekly", "credit"]);
    expect(all.all.get(all.second)).toHaveLength(1);
    expect(all.all.has(all.none)).toBe(false);
  });

  it("announces the account after it commits only when a reading changed", async () => {
    const { run, announced } = setup();
    const id = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        yield* accountUsage.record(id, [fiveHour(10, minutesFromNow(-5))], "read");
        return id;
      }),
    );
    expect(announced).toEqual([{ _tag: "record", topic: "provider", id, kind: "updated" }]);
  });

  it("ignores readings for an account that no longer exists", async () => {
    const [changed, rows] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* deleteAccount(id);
        const changed = yield* accountUsage.record(id, [fiveHour(40, NOW)], "session");
        return [changed, yield* countRows("account_usage_readings")] as const;
      }),
    );
    expect(changed).toBe(false);
    expect(rows).toBe(0);
  });

  it("deletes the readings and the read bookkeeping with the account", async () => {
    const [readings, reads] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "session");
        yield* accountUsage.claimRead(id);
        yield* deleteAccount(id);
        return [
          yield* countRows("account_usage_readings"),
          yield* countRows("account_usage_reads"),
        ] as const;
      }),
    );
    expect([readings, reads]).toEqual([0, 0]);
  });
});

describe("clearing readings", () => {
  const { run } = setup();

  it("deletes the account's readings but keeps the 15-minute limit on reads", async () => {
    const result = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        const other = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        yield* accountUsage.record(other, [fiveHour(50, NOW)], "read");
        const claimed = yield* accountUsage.claimRead(id);
        yield* accountUsage.clear(id);
        return {
          claimed,
          cleared: yield* accountUsage.read(id),
          untouched: yield* accountUsage.read(other),
          claimedAgain: yield* accountUsage.claimRead(id),
        };
      }),
    );
    expect(result.claimed).toBe(true);
    expect(result.cleared).toEqual([]);
    expect(result.untouched).toHaveLength(1);
    expect(result.claimedAgain).toBe(false);
  });
});

describe("claiming an active read", () => {
  const { run } = setup();

  it("grants one claim per 15 minutes", async () => {
    const claims = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        const first = yield* accountUsage.claimRead(id);
        yield* TestClock.adjust(15 * 60_000 - 1);
        const justBefore = yield* accountUsage.claimRead(id);
        yield* TestClock.adjust(1);
        const atInterval = yield* accountUsage.claimRead(id);
        const straightAfter = yield* accountUsage.claimRead(id);
        return [first, justBefore, atInterval, straightAfter];
      }),
    );
    expect(claims).toEqual([true, false, true, false]);
  });

  it("is refused while a session reported usage taken within 15 minutes", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], "session");
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(false);
  });

  it("is not blocked by an active read's own readings", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], "read");
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(true);
  });

  it("is not blocked by a session report that arrives late with an old time", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-20))], "session");
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(true);
  });

  it("measures a session report by the newest time taken, not by what arrived last", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], "session");
        yield* accountUsage.record(id, [weekly(10, minutesFromNow(-20))], "session");
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(false);
  });

  it("is refused for an account that does not exist", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* deleteAccount(id);
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(false);
  });
});
