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
export const USAGE_READ_INTERVAL_MILLIS = 15 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* accountUsageRepository;

  return {
    /**
     * Stores each reading unless the account already holds a reading of the
     * same window (or credit) that was taken at the same time or later:
     * readings are ordered by the time they were taken, not the time they
     * arrived. A `takenAt` later than the controller's now is stored as now.
     * All readings are stored in one transaction. For the source
     * `session`, the time of the account's newest session report is raised to
     * the newest `takenAt` of the readings. Announces the account on the
     * `provider` topic once the transaction commits, when any reading
     * changed.
     *
     * Returns whether any reading changed. A reading for an account that no
     * longer exists is ignored and not an error: the account may have been
     * deleted while a runner was still reporting.
     */
    record: (
      providerAccountId: string,
      received: ReadonlyArray<UsageReading>,
      source: AccountUsageSource,
    ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          // A reading is never dated after the controller's now. A runner whose
          // clock runs ahead would otherwise block active reads and outrank
          // every newer reading until the real time caught up.
          const now = new Date(yield* Clock.currentTimeMillis).toISOString();
          const readings = received.map((reading) =>
            reading.takenAt > now ? { ...reading, takenAt: now } : reading,
          );
          let changed = false;
          for (const reading of readings) {
            const stored = yield* repository.upsertReadingIfNewer(
              providerAccountId,
              reading,
              source,
            );
            changed = changed || stored;
          }
          if (source === "session" && readings.length > 0) {
            const newest = readings.reduce(
              (latest, reading) => (reading.takenAt > latest ? reading.takenAt : latest),
              readings[0]!.takenAt,
            );
            yield* repository.raiseReportedAt(providerAccountId, newest);
          }
          if (changed) {
            yield* announce({
              _tag: "record",
              topic: "provider",
              id: providerAccountId,
              kind: "updated",
            });
          }
          return changed;
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
     * Deletes the account's readings, because a new key or token may belong to
     * someone else and the old readings would be wrong. The caller replaces
     * the credential in the same transaction and announces the account. The
     * 15-minute limit on active reads is kept, so replacing a credential does
     * not allow a read sooner.
     */
    clear: (providerAccountId: string): Effect.Effect<void, SqlError> =>
      withTransaction(sql, repository.deleteReadings(providerAccountId)),
  };
});

/** The service that stores and reads the Account Usage of Provider Accounts. */
export class AccountUsage extends Context.Service<AccountUsage, Effect.Success<typeof make>>()(
  "hercule/controller/usage/AccountUsage",
) {}

export const AccountUsageLayer: Layer.Layer<AccountUsage, never, SqlClient.SqlClient> =
  Layer.effect(AccountUsage)(make);
