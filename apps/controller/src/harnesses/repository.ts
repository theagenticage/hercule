/**
 * The harness listing's reads, and the writes of the latest-release record.
 *
 * - The Capability Snapshots table belongs to the provider-accounts domain.
 *   It is read here with SQL because that domain imports this one (for the
 *   version floors), so this one cannot import it back.
 * - The `harness_releases` table belongs to this domain.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { HarnessLatestRelease } from "@hercule/contract";
import { uuidToString } from "../db";

/** Joins a harness id and a runner id into the key `readReportedVersions` uses. */
export const buildVersionKey = (harnessId: string, runnerId: string): string =>
  `${harnessId}|${runnerId}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Returns the harness version each runner last reported for each harness,
     * keyed by the harness id and the runner id as `buildVersionKey` joins
     * them. The newest probe of any account wins, because the version belongs
     * to the harness on that machine and not to an account. A harness that no
     * probe has seen on a runner has no entry.
     */
    readReportedVersions: (): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      Effect.map(
        sql<{
          readonly harness_id: string;
          readonly runner_id: Uint8Array;
          readonly harness_version: string;
        }>`
          SELECT harness_id, runner_id, harness_version FROM capability_snapshots
          WHERE harness_version IS NOT NULL
          ORDER BY probed_at DESC
        `,
        (rows) => {
          const versions = new Map<string, string>();
          for (const row of rows) {
            const key = buildVersionKey(row.harness_id, uuidToString(row.runner_id));
            // Newest first, so the first row of a key is the one to keep.
            if (!versions.has(key)) versions.set(key, row.harness_version);
          }
          return versions;
        },
      ),

    /**
     * Returns the stored latest release of every harness that has one, keyed
     * by the harness's qualified id, in one query. A harness the controller
     * has not tried to read has no entry.
     */
    readLatestReleases: (): Effect.Effect<ReadonlyMap<string, HarnessLatestRelease>, SqlError> =>
      Effect.map(
        sql<{
          readonly harness_id: string;
          readonly version: string | null;
          readonly checked_at: string | null;
          readonly error: string | null;
        }>`SELECT harness_id, version, checked_at, error FROM harness_releases`,
        (rows) =>
          new Map(
            rows.map((row) => [
              row.harness_id,
              { version: row.version, checkedAt: row.checked_at, error: row.error },
            ]),
          ),
      ),

    /**
     * Records that a read of the harness's latest release succeeded: stores
     * the version and `checkedAt`, and clears the error. Runs in the caller's
     * transaction.
     */
    recordReleaseRead: (
      harnessId: string,
      version: string,
      checkedAt: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO harness_releases (harness_id, version, checked_at, error)
        VALUES (${harnessId}, ${version}, ${checkedAt}, NULL)
        ON CONFLICT (harness_id) DO UPDATE SET
          version = excluded.version, checked_at = excluded.checked_at, error = NULL
      `),

    /**
     * Records that a read of the harness's latest release failed: stores
     * `error` and leaves the last good version and its time as they are. A
     * harness with no row gets one with no version. Runs in the caller's
     * transaction.
     */
    recordReleaseReadFailure: (harnessId: string, error: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO harness_releases (harness_id, version, checked_at, error)
        VALUES (${harnessId}, NULL, NULL, ${error})
        ON CONFLICT (harness_id) DO UPDATE SET error = excluded.error
      `),
  };
});

export const harnessRepository = make;
