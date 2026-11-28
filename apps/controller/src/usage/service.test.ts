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
import { AccountUsage, AccountUsageLayer, type UsageOrigin } from "./index";

const NOW = "2026-10-31T12:00:00.000Z";

/** A report from a session whose process started with the current credential, as far as anyone knows. */
const SESSION: UsageOrigin = { source: "session", credentialSince: null };

const READ: UsageOrigin = { source: "read" };

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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-10))], READ);
        const older = yield* accountUsage.record(id, [fiveHour(10, minutesFromNow(-30))], READ);
        const afterOlder = yield* accountUsage.read(id);
        const newer = yield* accountUsage.record(id, [fiveHour(60, minutesFromNow(-5))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(3))], SESSION);
        const afterEarly = yield* accountUsage.read(id);
        yield* TestClock.adjust(5 * 60_000);
        yield* accountUsage.record(id, [fiveHour(45, minutesFromNow(5))], READ);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(4))], SESSION);
        // At 12:01, a reading taken at 12:03 is older than the stored one.
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(30, minutesFromNow(3))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-1))], READ);
        const changed = yield* accountUsage.record(
          id,
          [fiveHour(50, minutesFromNow(20)), weekly(60, minutesFromNow(30)), credit(1, NOW)],
          SESSION,
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(4))], SESSION);
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
          SESSION,
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
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        const changed = yield* accountUsage.record(id, [fiveHour(55, NOW)], SESSION);
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
          READ,
        );
        // Newer for the five-hour window, older for the weekly window and the credit.
        yield* accountUsage.record(
          id,
          [credit(9, minutesFromNow(-20)), fiveHour(20, NOW), weekly(30, minutesFromNow(-20))],
          SESSION,
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
        yield* accountUsage.record(first, [credit(5, NOW), weekly(1, NOW), fiveHour(2, NOW)], READ);
        yield* accountUsage.record(second, [weekly(3, NOW)], READ);
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
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        yield* accountUsage.record(id, [fiveHour(10, minutesFromNow(-5))], READ);
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
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        before = announced.length;
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(1))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        before = announced.length;
        yield* TestClock.adjust(60_000);
        yield* accountUsage.record(id, [fiveHour(41, minutesFromNow(1))], SESSION);
        return id;
      }),
    );
    expect(announced.slice(before)).toEqual([
      { _tag: "record", topic: "provider", id, kind: "updated" },
    ]);
  });

  it("announces a reading of the same value when the last announcement is more than 5 minutes old", async () => {
    const { run, announced } = setup();
    let before = 0;
    const id = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        before = announced.length;
        yield* TestClock.adjust(6 * 60_000);
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(6))], SESSION);
        return id;
      }),
    );
    expect(announced.slice(before)).toEqual([
      { _tag: "record", topic: "provider", id, kind: "updated" },
    ]);
  });

  it("announces unchanged readings of two interleaved sources at least once every 5 minutes", async () => {
    const { run, announced } = setup();
    const times = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], SESSION);
        const announcedAt: Array<number> = [0];
        // Two sessions report the same value, alternately, 2.5 minutes apart.
        for (let step = 1; step <= 8; step++) {
          yield* TestClock.adjust(150_000);
          const before = announced.length;
          yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(step * 2.5))], SESSION);
          if (announced.length > before) announcedAt.push(step * 2.5);
        }
        return announcedAt;
      }),
    );
    expect(times).toEqual([0, 5, 10, 15, 20]);
  });

  it("announces an unchanged reading every time when its source reports every 5 minutes", async () => {
    const { run, announced } = setup();
    const count = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], SESSION);
        const before = announced.length;
        for (let step = 1; step <= 3; step++) {
          yield* TestClock.adjust(5 * 60_000);
          yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(step * 5))], SESSION);
        }
        return announced.length - before;
      }),
    );
    expect(count).toBe(3);
  });

  it("ignores readings for an account that no longer exists", async () => {
    const [changed, rows] = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* deleteAccount(id);
        const changed = yield* accountUsage.record(id, [fiveHour(40, NOW)], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, NOW)], SESSION);
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

describe("an endpoint read's whole answer", () => {
  const limitedCredit = (remaining: number, takenAt: string): UsageReading => ({
    kind: "credit",
    remaining,
    limit: 100,
    takenAt,
  });

  /** An endpoint read whose answer arrived at `takenAt`. */
  const answerAt = (takenAt: string): UsageOrigin => ({ source: "read", wholeAnswerAt: takenAt });

  it("removes the credit of a key whose limit was taken off, and announces the account", async () => {
    const { run, announced } = setup();
    let before = 0;
    const outcome = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(
          id,
          [limitedCredit(50, minutesFromNow(-20))],
          answerAt(minutesFromNow(-20)),
        );
        before = announced.length;
        yield* TestClock.adjust(60_000);
        const changed = yield* accountUsage.record(id, [], answerAt(minutesFromNow(1)));
        return { id, changed, readings: yield* accountUsage.read(id) };
      }),
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.readings).toEqual([]);
    expect(announced.slice(before)).toEqual([
      { _tag: "record", topic: "provider", id: outcome.id, kind: "updated" },
    ]);
  });

  it("removes a window the answer no longer gives and keeps the ones it gives", async () => {
    const { run } = setup();
    const readings = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(
          id,
          [fiveHour(40, minutesFromNow(-20)), weekly(20, minutesFromNow(-20))],
          answerAt(minutesFromNow(-20)),
        );
        yield* accountUsage.record(
          id,
          [fiveHour(41, minutesFromNow(-5))],
          answerAt(minutesFromNow(-5)),
        );
        return yield* accountUsage.read(id);
      }),
    );
    expect(readings).toMatchObject([{ kind: "window", window: "five-hour", usedPercent: 41 }]);
  });

  it("leaves a session's readings alone, because a session reports only what changed", async () => {
    const { run } = setup();
    const readings = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-20))], SESSION);
        yield* accountUsage.record(id, [weekly(20, minutesFromNow(-15))], SESSION);
        // A later session report of one window removes nothing of the other.
        yield* accountUsage.record(id, [fiveHour(45, minutesFromNow(-10))], SESSION);
        // And an endpoint read removes none of what sessions reported.
        yield* accountUsage.record(id, [], answerAt(NOW));
        return yield* accountUsage.read(id);
      }),
    );
    expect(readings).toMatchObject([
      { window: "five-hour", usedPercent: 45, source: "session" },
      { window: "weekly", usedPercent: 20, source: "session" },
    ]);
  });

  it("leaves the readings alone when it is not an endpoint read", async () => {
    const { run } = setup();
    const readings = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-20))], READ);
        yield* accountUsage.record(id, [weekly(20, minutesFromNow(-5))], READ);
        return yield* accountUsage.read(id);
      }),
    );
    expect(readings).toMatchObject([{ window: "five-hour" }, { window: "weekly" }]);
  });

  it("does not let an older read remove a reading that was taken after it", async () => {
    const { run, announced } = setup();
    let before = 0;
    const outcome = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [limitedCredit(50, minutesFromNow(-5))], answerAt(NOW));
        before = announced.length;
        const changed = yield* accountUsage.record(id, [], answerAt(minutesFromNow(-30)));
        return { changed, readings: yield* accountUsage.read(id) };
      }),
    );
    expect(outcome.changed).toBe(false);
    expect(outcome.readings).toMatchObject([{ kind: "credit", remaining: 50 }]);
    expect(announced.slice(before)).toEqual([]);
  });
});

describe("clearing readings", () => {
  const { run } = setup();

  it("deletes the account's readings and makes the account due for a read at once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        const other = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, NOW)], READ);
        yield* accountUsage.record(other, [fiveHour(50, NOW)], READ);
        const claimed = yield* accountUsage.claimRead(id);
        const claimedOther = yield* accountUsage.claimRead(other);
        yield* accountUsage.clear(id);
        return {
          claimed,
          cleared: yield* accountUsage.read(id),
          untouched: yield* accountUsage.read(other),
          dueAfterClear: yield* accountUsage.listDueAccounts([id, other]),
          claimedAgain: yield* accountUsage.claimRead(id),
          claimedAgainTwice: yield* accountUsage.claimRead(id),
          claimedOtherAgain: yield* accountUsage.claimRead(other),
          ids: { id, other },
          claimedOther,
        };
      }),
    );
    expect(result.claimed).toBe(true);
    expect(result.cleared).toEqual([]);
    expect(result.untouched).toHaveLength(1);
    // The cleared account is due at once, the other still waits its 15 minutes.
    expect(result.dueAfterClear).toEqual([result.ids.id]);
    expect(result.claimedAgain).toBe(true);
    // The new claim starts the 15 minutes over.
    expect(result.claimedAgainTwice).toBe(false);
    expect(result.claimedOtherAgain).toBe(false);
  });

  it("makes an account due again even when a session reported usage just now", async () => {
    const result = await run(
      Effect.gen(function* () {
        const accountUsage = yield* AccountUsage;
        const id = yield* addAccount;
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], SESSION);
        const beforeClear = yield* accountUsage.claimRead(id);
        yield* accountUsage.clear(id);
        return { beforeClear, afterClear: yield* accountUsage.claimRead(id) };
      }),
    );
    expect(result).toEqual({ beforeClear: false, afterClear: true });
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
        const fromOld = yield* accountUsage.record(id, [fiveHour(70, minutesFromNow(1))], {
          source: "session",
          credentialSince: oldProcess,
        });
        const afterOld = yield* accountUsage.read(id);
        const fromNew = yield* accountUsage.record(id, [fiveHour(10, minutesFromNow(1))], {
          source: "session",
          credentialSince: minutesFromNow(1),
        });
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
        yield* accountUsage.record(replaced, [fiveHour(70, minutesFromNow(1))], {
          source: "session",
          credentialSince: null,
        });
        yield* accountUsage.record(untouched, [fiveHour(20, minutesFromNow(1))], {
          source: "session",
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
        yield* accountUsage.record(id, [fiveHour(70, minutesFromNow(1))], READ);
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
        yield* accountUsage.record(reported, [fiveHour(40, minutesFromNow(-5))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], READ);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-20))], SESSION);
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
        yield* accountUsage.record(id, [fiveHour(40, minutesFromNow(-5))], SESSION);
        yield* accountUsage.record(id, [weekly(10, minutesFromNow(-20))], SESSION);
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
