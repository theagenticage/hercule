/**
 * The one read the harness listing makes on the Capability Snapshots table,
 * which the provider-accounts domain owns. It is read here with SQL because
 * that domain imports this one (for the version floors), so this one cannot
 * import it back.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
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
  };
});

export const harnessRepository = make;
