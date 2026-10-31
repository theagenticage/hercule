/**
 * The rows of Account Usage: the latest reading per usage window and credit of
 * each Provider Account, and the bookkeeping that limits active reads. Every
 * write here is an upsert guarded in SQL, so two writers racing each other
 * cannot leave an older reading in place of a newer one.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { AccountUsageReading, AccountUsageSource } from "@hercule/contract";
import { UsageReading } from "@hercule/protocol";
import { uuidFromString, uuidToString } from "../db";

const READING_ORDER = ["five-hour", "weekly", "monthly", "credit"] as const;

type ReadingIdentity = (typeof READING_ORDER)[number];

/** Returns what names a reading among an account's readings: its window, or `credit`. */
const identifyReading = (reading: UsageReading): ReadingIdentity =>
  reading.kind === "credit" ? "credit" : reading.window;

interface ReadingRow {
  readonly provider_account_id: Uint8Array;
  readonly reading: ReadingIdentity;
  readonly source: AccountUsageSource;
  readonly value: string;
}

const readingCodec = Schema.fromJsonString(UsageReading);
const decodeReading = Schema.decodeUnknownEffect(readingCodec);
const encodeReading = Schema.encodeEffect(readingCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Turns stored rows into readings, grouped by account and sorted five-hour, weekly, monthly, credit. */
  const toReadingsByAccount = (
    rows: ReadonlyArray<ReadingRow>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<AccountUsageReading>>, Schema.SchemaError> =>
    Effect.gen(function* () {
      const sorted = [...rows].sort(
        (a, b) => READING_ORDER.indexOf(a.reading) - READING_ORDER.indexOf(b.reading),
      );
      const byAccount = new Map<string, Array<AccountUsageReading>>();
      for (const row of sorted) {
        const reading = yield* decodeReading(row.value);
        const id = uuidToString(row.provider_account_id);
        const list = byAccount.get(id) ?? [];
        list.push({ ...reading, source: row.source });
        byAccount.set(id, list);
      }
      return byAccount;
    });

  return {
    /**
     * Stores the reading unless the account already has a reading of the same
     * window (or credit) that was taken at the same time or later. Returns
     * whether the reading was stored. Returns false, and writes nothing, for
     * an account that does not exist. Timestamps are fixed-width UTC, so the
     * comparison in SQL compares them as text. Must run in a transaction.
     */
    upsertReadingIfNewer: (
      providerAccountId: string,
      reading: UsageReading,
      source: AccountUsageSource,
    ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const value = yield* encodeReading(reading);
        const rows = yield* sql<{ readonly changed: number }>`
          INSERT INTO account_usage_readings (provider_account_id, reading, source, taken_at, value)
          SELECT id, ${identifyReading(reading)}, ${source}, ${reading.takenAt}, ${value}
          FROM provider_accounts
          WHERE id = ${uuidFromString(providerAccountId)}
          ON CONFLICT (provider_account_id, reading) DO UPDATE
          SET source = excluded.source, taken_at = excluded.taken_at, value = excluded.value
          WHERE excluded.taken_at > account_usage_readings.taken_at
          RETURNING 1 AS changed
        `;
        return rows.length > 0;
      }),

    /**
     * Raises the time of the newest session report of the account to `at`.
     * An earlier `at` changes nothing. Does nothing for an account that does
     * not exist. Must run in a transaction.
     */
    raiseReportedAt: (providerAccountId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO account_usage_reads (provider_account_id, reported_at)
        SELECT id, ${at} FROM provider_accounts WHERE id = ${uuidFromString(providerAccountId)}
        ON CONFLICT (provider_account_id) DO UPDATE
        SET reported_at = excluded.reported_at
        WHERE account_usage_reads.reported_at IS NULL
           OR excluded.reported_at > account_usage_reads.reported_at
      `),

    /**
     * Stores `now` as the start of an active read and returns true, but only
     * when the last active read started at or before `cutoff` (or never) and
     * the newest session report was taken at or before `cutoff` (or none was). Otherwise changes nothing and returns
     * false, as it does for an account that does not exist. This is one
     * statement, so two callers cannot both win. Must run in a transaction.
     */
    claimRead: (
      providerAccountId: string,
      now: string,
      cutoff: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly claimed: number }>`
          INSERT INTO account_usage_reads (provider_account_id, read_started_at)
          SELECT id, ${now} FROM provider_accounts WHERE id = ${uuidFromString(providerAccountId)}
          ON CONFLICT (provider_account_id) DO UPDATE
          SET read_started_at = excluded.read_started_at
          WHERE (account_usage_reads.read_started_at IS NULL
                 OR account_usage_reads.read_started_at <= ${cutoff})
            AND (account_usage_reads.reported_at IS NULL
                 OR account_usage_reads.reported_at <= ${cutoff})
          RETURNING 1 AS claimed
        `,
        (rows) => rows.length > 0,
      ),

    /** Deletes the account's readings. The bookkeeping of active reads stays. Must run in a transaction. */
    deleteReadings: (providerAccountId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        DELETE FROM account_usage_readings
        WHERE provider_account_id = ${uuidFromString(providerAccountId)}
      `),

    /** Returns every account's readings in one query. An account with none has no entry. */
    readAll: (): Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<AccountUsageReading>>,
      SqlError | Schema.SchemaError
    > =>
      Effect.flatMap(
        sql<ReadingRow>`
          SELECT provider_account_id, reading, source, value FROM account_usage_readings
        `,
        toReadingsByAccount,
      ),

    /** Returns one account's readings, sorted five-hour, weekly, monthly, credit. */
    readOne: (
      providerAccountId: string,
    ): Effect.Effect<ReadonlyArray<AccountUsageReading>, SqlError | Schema.SchemaError> =>
      Effect.map(
        Effect.flatMap(
          sql<ReadingRow>`
            SELECT provider_account_id, reading, source, value FROM account_usage_readings
            WHERE provider_account_id = ${uuidFromString(providerAccountId)}
          `,
          toReadingsByAccount,
        ),
        (byAccount) => byAccount.get(providerAccountId) ?? [],
      ),
  };
});

export const accountUsageRepository = make;
