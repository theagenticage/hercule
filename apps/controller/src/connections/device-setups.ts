/**
 * Reads and writes the `device_setups` table: device flows where the user has
 * been shown a code and the controller has not collected the token yet.
 *
 * A row is looked up by its `setup_id`, which the controller minted and the
 * client polls with. A row is deleted when a poll ends the flow, not marked as
 * ended, so a flow that has ended is indistinguishable from one that never
 * existed: both are `expired` to the caller.
 *
 * Every method joins the caller's transaction. `claimPoll` reads and then
 * writes, so the caller runs it in a transaction of its own.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString, uuidToString } from "../db";

/** A pending device flow, with its JSON columns read. */
export interface StoredDeviceSetup {
  readonly setupId: string;
  /** The qualified connection type, which also identifies the plugin that owns the flow. */
  readonly type: string;
  /** Set when the flow reconnects a connection that already exists. */
  readonly connectionId: string | undefined;
  readonly label: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
  /** The provider's device code, which only the controller ever sends back to it. */
  readonly deviceCode: string;
  /** Seconds the provider wants between two polls. */
  readonly interval: number;
}

/** Everything a new flow stores. */
export interface NewDeviceSetup extends StoredDeviceSetup {
  readonly nextPollAt: string;
  readonly expiresAt: string;
  readonly at: string;
}

/**
 * What a poll may do now.
 *
 * - `expired`: no flow has this id, or its device code has expired.
 * - `early`: the provider's interval has not passed since the last poll, so
 *   the provider must not be asked yet. `interval` is the current interval.
 * - `claimed`: this poll may ask the provider. The next poll is already
 *   pushed back by one interval.
 */
export type PollClaim =
  | { readonly _tag: "expired" }
  | { readonly _tag: "early"; readonly interval: number }
  | { readonly _tag: "claimed"; readonly setup: StoredDeviceSetup };

interface DeviceSetupRow {
  readonly setup_id: string;
  readonly type: string;
  readonly connection_id: Uint8Array | null;
  readonly label: string;
  readonly labels: string;
  readonly config: string;
  readonly device_code: string;
  readonly interval_seconds: number;
  readonly next_poll_at: string;
  readonly expires_at: string;
}

const COLUMNS =
  "setup_id, type, connection_id, label, labels, config, device_code, interval_seconds, " +
  "next_poll_at, expires_at";

/**
 * Parses a JSON column. Only this repository writes these columns, so a column
 * that does not parse means the database is broken.
 */
const parseJson = <A>(text: string): A => JSON.parse(text) as A;

const toDeviceSetup = (row: DeviceSetupRow): StoredDeviceSetup => ({
  setupId: row.setup_id,
  type: row.type,
  connectionId: row.connection_id === null ? undefined : uuidToString(row.connection_id),
  label: row.label,
  labels: parseJson<ReadonlyArray<string>>(row.labels),
  config: parseJson<Record<string, Schema.Json>>(row.config),
  deviceCode: row.device_code,
  interval: row.interval_seconds,
});

/** Returns the timestamp `seconds` after `at`. */
const addSeconds = (at: string, seconds: number): string =>
  new Date(Date.parse(at) + seconds * 1000).toISOString();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (setup: NewDeviceSetup): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO device_setups
          (setup_id, type, connection_id, label, labels, config, device_code,
           interval_seconds, next_poll_at, expires_at, created_at)
        VALUES
          (${setup.setupId}, ${setup.type},
           ${setup.connectionId === undefined ? null : uuidFromString(setup.connectionId)},
           ${setup.label}, ${JSON.stringify(setup.labels)}, ${JSON.stringify(setup.config)},
           ${setup.deviceCode}, ${setup.interval}, ${setup.nextPollAt}, ${setup.expiresAt},
           ${setup.at})
      `),

    /**
     * Decides whether a poll at `at` may ask the provider, and when it may,
     * pushes the next poll back by one interval before returning the setup.
     * The caller runs this in its own transaction, so two polls that arrive
     * together cannot both claim the same moment.
     */
    claimPoll: (setupId: string, at: string): Effect.Effect<PollClaim, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<DeviceSetupRow>`
          SELECT ${sql.literal(COLUMNS)} FROM device_setups WHERE setup_id = ${setupId}
        `;
        const row = rows[0];
        if (row === undefined || row.expires_at <= at) return { _tag: "expired" } as const;
        if (at < row.next_poll_at) {
          return { _tag: "early", interval: row.interval_seconds } as const;
        }
        yield* sql`
          UPDATE device_setups SET next_poll_at = ${addSeconds(at, row.interval_seconds)}
          WHERE setup_id = ${setupId}
        `;
        return { _tag: "claimed", setup: toDeviceSetup(row) } as const;
      }),

    /**
     * Stores the longer interval the provider asked for, and pushes the next
     * poll back to one new interval after `at`.
     */
    slowDown: (setupId: string, interval: number, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE device_setups
        SET interval_seconds = ${interval}, next_poll_at = ${addSeconds(at, interval)}
        WHERE setup_id = ${setupId}
      `),

    /**
     * Deletes the setup, which ends the flow, and returns whether there was a
     * row to delete. `false` means another poll ended the flow first.
     */
    spend: (setupId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`DELETE FROM device_setups WHERE setup_id = ${setupId} RETURNING setup_id`,
        (deleted) => deleted.length > 0,
      ),

    /**
     * Deletes the expired rows: flows the user never finished. Called on each
     * new start rather than on a timer.
     */
    sweep: (at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM device_setups WHERE expires_at <= ${at}`),
  };
});

export const deviceSetupRepository = make;
