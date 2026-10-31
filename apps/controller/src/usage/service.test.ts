/**
 * Tests Account Usage on a real database: readings are ordered by the time
 * they were taken, and an active read is claimed at most every 15 minutes.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Logger } from "effect";
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

/** Runs an effect with the controller's clock held at `NOW` and returns it with the announcements and the log lines. */
const setup = () => {
  const logged: Array<{ readonly level: string; readonly message: string }> = [];
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
      }).pipe(
        Effect.provide(layer),
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>(({ logLevel, message }) => {
              logged.push({ level: logLevel, message: String(message) });
            }),
          ]),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
  return { run, announced: recorder.announced, logged };
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

  it("keeps a reading's own time, so a slightly early clock cannot outrank a later real reading", async () => {
    const [afterEarly, afterReal] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        // Taken 3 minutes ahead of the controller's clock: within the allowed difference.
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(3))], "session");
        const afterEarly = yield* accountUsage.read(id);
        yield* TestClock.adjust(5 * 60_000);
        yield* accountUsage.record(id, [fiveHour(45, minutesFromNow(5))], "read");
        return [afterEarly, yield* accountUsage.read(id)] as const;
      }),
    );
    expect(afterEarly).toMatchObject([{ usedPercent: 40, takenAt: minutesFromNow(3) }]);
    expect(afterReal).toMatchObject([{ usedPercent: 45, takenAt: minutesFromNow(5) }]);
  });

  it("never lets an older reading replace a newer one, also when both are dated after now", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        // At 12:00, a reading taken at 12:04 (the runner's clock is 4 minutes ahead).
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(4))], "session");
        // At 12:01, a reading taken at 12:03 is older than the stored one.
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(30, minutesFromNow(3))], "session");
        return yield* accountUsage.read(id);
      }),
    );
    expect(stored).toMatchObject([{ usedPercent: 40, takenAt: minutesFromNow(4) }]);
  });

  it("drops readings dated more than 5 minutes ahead and logs one warning that names the account", async () => {
    const { run, logged } = setup();
    const [id, stored] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-1))], "read");
        const changed = yield* accountUsage.record(
          id,
          [fiveHour(50, minutesFromNow(20)), weekly(60, minutesFromNow(30)), credit(1, NOW)],
          "session",
        );
        return [id, { changed, readings: yield* accountUsage.read(id) }] as const;
      }),
    );
    expect(stored.changed).toBe(true);
    expect(stored.readings).toMatchObject([
      { kind: "window", window: "five-hour", usedPercent: 40 },
      { kind: "credit", remaining: 1 },
    ]);
    const warnings = logged.filter((line) => line.level === "Warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(id);
    expect(warnings[0]!.message).toContain("30 minutes ahead");
  });

  it("does not let a reading from the future raise the time of the newest session report", async () => {
    const claim = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(4))], "session");
        yield* TestClock.adjust(15 * 60_000);
        return yield* accountUsage.claimRead(id);
      }),
    );
    expect(claim).toBe(true);
  });

  it("stores only the newest of several readings of one window in a report", async () => {
    const [changed, stored] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        const changed = yield* accountUsage.record(
          id,
          [
            fiveHour(10, minutesFromNow(-3)),
            fiveHour(30, minutesFromNow(-1)),
            fiveHour(20, minutesFromNow(-2)),
          ],
          "session",
        );
        return [changed, yield* accountUsage.read(id)] as const;
      }),
    );
    expect(changed).toBe(true);
    expect(stored).toMatchObject([{ usedPercent: 30, takenAt: minutesFromNow(-1) }]);
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

  it("announces the account after it commits only when a reading was stored and changed", async () => {
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

  it("stores a newer reading of the same value without announcing it", async () => {
    const { run, announced } = setup();
    let before = 0;
    const stored = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        before = announced.length;
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(1))], "session");
        return yield* accountUsage.read(id);
      }),
    );
    expect(announced.slice(before)).toEqual([]);
    expect(stored).toMatchObject([
      { usedPercent: 40, takenAt: minutesFromNow(1), source: "session" },
    ]);
  });

  it("announces a newer reading whose value changed", async () => {
    const { run, announced } = setup();
    let before = 0;
    const id = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        before = announced.length;
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(41, minutesFromNow(1))], "session");
        return id;
      }),
    );
    expect(announced.slice(before)).toEqual([
      { _tag: "record", topic: "provider", id, kind: "updated" },
    ]);
  });

  it("announces a reading of the same value when the stored one is more than 5 minutes older", async () => {
    const { run, announced } = setup();
    let before = 0;
    const id = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], "read");
        before = announced.length;
        yield* TestClock.adjust(6 * 60_000);
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(6))], "session");
        return id;
      }),
    );
    expect(announced.slice(before)).toEqual([
      { _tag: "record", topic: "provider", id, kind: "updated" },
    ]);
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

describe("a session report after the credential was replaced", () => {
  const { run } = setup();

  it("is dropped when the session's process started before the replacement, and kept when it started after", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        const oldProcess = minutesFromNow(-30);
        yield* accountUsage.clear(id);
        yield* TestClock.adjust(60_000);
        const fromOld = yield* accountUsage.record(
          id,
          [fiveHour(70, minutesFromNow(1))],
          "session",
          {
            credentialSince: oldProcess,
          },
        );
        const afterOld = yield* accountUsage.read(id);
        const fromNew = yield* accountUsage.record(
          id,
          [fiveHour(10, minutesFromNow(1))],
          "session",
          {
            credentialSince: minutesFromNow(1),
          },
        );
        return { fromOld, afterOld, fromNew, afterNew: yield* accountUsage.read(id) };
      }),
    );
    expect(outcome.fromOld).toBe(false);
    expect(outcome.afterOld).toEqual([]);
    expect(outcome.fromNew).toBe(true);
    expect(outcome.afterNew).toMatchObject([{ usedPercent: 10, source: "session" }]);
  });

  it("is dropped when the process start is unknown, but only for an account whose credential was replaced", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const replaced = yield* addAccount;
        const untouched = yield* addAccount;
        yield* accountUsage.clear(replaced);
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(replaced, [fiveHour(70, minutesFromNow(1))], "session", {
          credentialSince: null,
        });
        yield* accountUsage.record(untouched, [fiveHour(20, minutesFromNow(1))], "session", {
          credentialSince: null,
        });
        return {
          replaced: yield* accountUsage.read(replaced),
          untouched: yield* accountUsage.read(untouched),
        };
      }),
    );
    expect(outcome.replaced).toEqual([]);
    expect(outcome.untouched).toHaveLength(1);
  });

  it("does not stop an active read from storing its readings", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.clear(id);
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(70, minutesFromNow(1))], "read");
        return yield* accountUsage.read(id);
      }),
    );
    expect(stored).toHaveLength(1);
  });
});

describe("listing the accounts that are due for an active read", () => {
  const { run } = setup();

  it("lists the accounts a claim would succeed for, in the order given, and claims nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const fresh = yield* addAccount;
        const claimed = yield* addAccount;
        const reported = yield* addAccount;
        yield* accountUsage.claimRead(claimed);
        yield* accountUsage.record(reported, [fiveHour(40, minutesFromNow(-5))], "session");
        const due = yield* accountUsage.listDueAccounts([reported, claimed, fresh]);
        const dueAgain = yield* accountUsage.listDueAccounts([fresh]);
        const claim = yield* accountUsage.claimRead(fresh);
        yield* TestClock.adjust(15 * 60_000);
        const later = yield* accountUsage.listDueAccounts([reported, claimed, fresh]);
        return { due, dueAgain, claim, later, ids: { fresh, claimed, reported } };
      }),
    );
    expect(outcome.due).toEqual([outcome.ids.fresh]);
    expect(outcome.dueAgain).toEqual([outcome.ids.fresh]);
    expect(outcome.claim).toBe(true);
    expect(outcome.later).toEqual([outcome.ids.reported, outcome.ids.claimed, outcome.ids.fresh]);
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
