/**
 * Account Usage: what a Provider Account has used of its limits or credit, as
 * last reported (spec 06 section 18).
 *
 * The methods here are internal. The controller daemon calls them when a
 * running session or an active read reports usage, and the Provider Account
 * service calls them to fill the account it returns. None is a public
 * operation, so none checks a grant: like a probe, a report gathers a fact
 * and the system is the actor for every row it writes.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { AccountUsageReading, AccountUsageSource } from "@hercule/contract";
import type { UsageReading } from "@hercule/protocol";
import { announce, withTransaction } from "../db";
import { accountUsageRepository } from "./repository";

/**
 * How long an account is left alone after an active read started or a session
 * reported usage (spec 06 section 18.2). A running session reports for free,
 * and a subscription read starts a harness process on a runner, so reads are
 * kept rare.
 */
const USAGE_READ_INTERVAL_MILLIS = 15 * 60 * 1000;

/**
 * How far after the controller's now a reading may be dated before it counts
 * as a clock error. A runner's clock differs a little from the controller's, so
 * a small difference is normal. Beyond this, the runner's clock is wrong and
 * its readings are dropped.
 */
const MAX_CLOCK_AHEAD_MILLIS = 5 * 60 * 1000;

/**
 * How much older the stored reading may be before a reading with the same
 * value is announced anyway. A client shows when a reading was taken, so
 * without this a gauge that never changes would show an ever older time. With
 * it, that time is at most this stale, and an unchanged account is announced
 * at most once per interval, however often its sessions report.
 */
const ANNOUNCE_UNCHANGED_AFTER_MILLIS = 5 * 60 * 1000;

/** Returns the newest reading of each window (and of the credit), in the order they first appear. */
const keepNewestOfEach = (readings: ReadonlyArray<UsageReading>): ReadonlyArray<UsageReading> => {
  const newest = new Map<string, UsageReading>();
  for (const reading of readings) {
    const identity = reading.kind === "credit" ? "credit" : reading.window;
    const kept = newest.get(identity);
    if (kept === undefined || reading.takenAt > kept.takenAt) newest.set(identity, reading);
  }
  return [...newest.values()];
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* accountUsageRepository;

  return {
    /**
     * Stores readings the account has no newer reading of, and announces the
     * account on the `provider` topic once the transaction commits, when a
     * client needs to hear of it. Returns whether any reading was stored.
     *
     * - Readings are ordered by the time they were taken, not the time they
     *   arrived: a reading of the same window (or credit) that was taken at
     *   the same time or earlier than the stored one is ignored.
     * - Of several readings of one window in one call, only the newest is
     *   considered.
     * - A reading dated more than 5 minutes after the controller's now is a
     *   clock error of the reporter. It is dropped, and one warning names the
     *   account and how far ahead the newest such reading was. Its time is
     *   not clamped, because a clamped time would rank it above readings that
     *   are really newer.
     * - A newer reading is always stored, so the stored time is current. It
     *   is announced only when its value (ignoring time and source) differs
     *   from the stored one, or the stored one is more than 5 minutes older.
     * - For the source `session`, the time of the account's newest session
     *   report is raised to the newest `takenAt` kept, but not beyond now.
     * - `options.credentialSince` is for a report from a running session: the
     *   time the session's process got its credential, or null when unknown.
     *   The report is dropped when the account's readings were cleared (its
     *   key or token replaced) at or after that time, because the process
     *   still holds the old credential and may report someone else's usage.
     *
     * A reading for an account that no longer exists is ignored and not an
     * error: the account may have been deleted while a runner was still
     * reporting. All readings are stored in one transaction.
     */
    record: (
      providerAccountId: string,
      received: ReadonlyArray<UsageReading>,
      source: AccountUsageSource,
      options?: { readonly credentialSince: string | null },
    ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (options !== undefined) {
            const clearedAt = yield* repository.readClearedAt(providerAccountId);
            if (
              clearedAt !== null &&
              (options.credentialSince === null || options.credentialSince <= clearedAt)
            ) {
              return yield* Effect.logDebug(
                "Dropped a session's usage report, because its process started before the account's credential was replaced",
              ).pipe(Effect.annotateLogs({ providerAccountId }), Effect.as(false));
            }
          }
          const nowMillis = yield* Clock.currentTimeMillis;
          const now = new Date(nowMillis).toISOString();
          const latestPlausible = new Date(nowMillis + MAX_CLOCK_AHEAD_MILLIS).toISOString();
          const [ahead, plausible] = [
            received.filter((reading) => reading.takenAt > latestPlausible),
            received.filter((reading) => reading.takenAt <= latestPlausible),
          ];
          if (ahead.length > 0) {
            const furthest = ahead.reduce((a, b) => (b.takenAt > a.takenAt ? b : a));
            const minutesAhead = Math.round((Date.parse(furthest.takenAt) - nowMillis) / 60_000);
            yield* Effect.logWarning(
              `Dropped ${ahead.length} usage reading(s) of provider account ${providerAccountId} ` +
                `dated up to ${minutesAhead} minutes ahead of the controller's clock; ` +
                "the clock of the machine that reported them is probably wrong",
            ).pipe(Effect.annotateLogs({ providerAccountId, minutesAhead }));
          }
          const readings = keepNewestOfEach(plausible);
          let stored = false;
          let announceable = false;
          for (const reading of readings) {
            const write = yield* repository.upsertReadingIfNewer(
              providerAccountId,
              reading,
              source,
            );
            if (!write.stored) continue;
            stored = true;
            announceable ||=
              write.valueChanged ||
              write.previousTakenAt === null ||
              Date.parse(reading.takenAt) - Date.parse(write.previousTakenAt) >
                ANNOUNCE_UNCHANGED_AFTER_MILLIS;
          }
          if (source === "session" && readings.length > 0) {
            const newest = readings.reduce(
              (latest, reading) => (reading.takenAt > latest ? reading.takenAt : latest),
              readings[0]!.takenAt,
            );
            yield* repository.raiseReportedAt(providerAccountId, newest < now ? newest : now);
          }
          if (announceable) {
            yield* announce({
              _tag: "record",
              topic: "provider",
              id: providerAccountId,
              kind: "updated",
            });
          }
          return stored;
        }),
      ),

    /**
     * Returns every account's readings in one query, each list sorted
     * five-hour, weekly, monthly, credit. An account with no readings has no
     * entry.
     */
    readAll: (): Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<AccountUsageReading>>,
      SqlError | Schema.SchemaError
    > => repository.readAll(),

    /**
     * Returns one account's readings, sorted five-hour, weekly, monthly,
     * credit. Returns none for an account without readings or that does not
     * exist.
     */
    read: (
      providerAccountId: string,
    ): Effect.Effect<ReadonlyArray<AccountUsageReading>, SqlError | Schema.SchemaError> =>
      repository.readOne(providerAccountId),

    /**
     * Claims the right to read the account's usage actively, and returns
     * whether the caller got it. It is granted only when the last claim is at
     * least 15 minutes old (or there is none) and no session reported usage
     * taken less than 15 minutes ago ({@link USAGE_READ_INTERVAL_MILLIS}).
     * The claim is stored before the read starts and is never given back, so a
     * read that fails still counts: the next one waits for the interval too.
     * Two callers at once cannot both succeed. Returns false for an account
     * that does not exist.
     */
    claimRead: (providerAccountId: string): Effect.Effect<boolean, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const nowMillis = yield* Clock.currentTimeMillis;
          return yield* repository.claimRead(
            providerAccountId,
            new Date(nowMillis).toISOString(),
            new Date(nowMillis - USAGE_READ_INTERVAL_MILLIS).toISOString(),
          );
        }),
      ),

    /**
     * Returns the ids among `providerAccountIds` for which `claimRead` would
     * succeed now, in the order given, without claiming anything. It reads
     * the bookkeeping once, so a caller can find the few accounts that are
     * due without a write transaction per account. `claimRead` stays the gate
     * right before a read: another caller may claim between the two.
     */
    listDueAccounts: (
      providerAccountIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.flatMap(Clock.currentTimeMillis, (nowMillis) =>
        repository.filterClaimable(
          providerAccountIds,
          new Date(nowMillis - USAGE_READ_INTERVAL_MILLIS).toISOString(),
        ),
      ),

    /**
     * Deletes the account's readings, because a new key or token may belong to
     * someone else and the old readings would be wrong. Stores the time, so a
     * report from a session whose process started with the old credential is
     * dropped (see `record`). The caller replaces the credential in the same
     * transaction and announces the account. The 15-minute limit on active
     * reads is kept, so replacing a credential does not allow a read sooner.
     */
    clear: (providerAccountId: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.flatMap(Clock.currentTimeMillis, (nowMillis) =>
          repository.deleteReadings(providerAccountId, new Date(nowMillis).toISOString()),
        ),
      ),
  };
});

/** The service that stores and reads the Account Usage of Provider Accounts. */
export class AccountUsage extends Context.Service<AccountUsage, Effect.Success<typeof make>>()(
  "hercule/controller/usage/AccountUsage",
) {}

export const AccountUsageLayer: Layer.Layer<AccountUsage, never, SqlClient.SqlClient> =
  Layer.effect(AccountUsage)(make);
