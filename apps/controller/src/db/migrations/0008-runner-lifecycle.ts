/**
 * Splits the runner state into two columns, and adds the reserved flag and a
 * unique name across the fleet.
 *
 * `state` held five values for two questions that change independently:
 * whether the controller can reach the machine, and where the machine stands
 * with its owner. The column is split into `connectivity` and `lifecycle`.
 *
 * `max_concurrent_sessions` becomes nullable, where `NULL` means the cap is
 * derived from the reported memory when it is read. Facts first arrive at hello
 * rather than at join, so nothing can be derived at insert. Every existing row
 * is set to `NULL`, and a cap that was set through the API is logged as it is
 * discarded.
 *
 * Names were never unique, so the fleet could have two runners with the same
 * name when the unique index below is created. The later rows are renamed
 * rather than failing the boot, since a duplicate name is for the user to sort
 * out. The new name uses the last eight hex digits of the row's id, which are
 * the random ones: a UUIDv7 uses its first twelve for a millisecond clock. The
 * old name is logged, because nothing else would record what the machine used
 * to be called. The boot still fails if the new name is already taken.
 *
 * The table is rebuilt rather than altered because SQLite cannot drop a CHECK
 * or relax a NOT NULL in place, and the old `state` CHECK names five values
 * that are going away.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE runners_new (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK (length(name) > 0),
      connectivity TEXT NOT NULL CHECK (connectivity IN ('online', 'offline', 'unreachable')),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'draining', 'retired')),
      reserved INTEGER NOT NULL CHECK (reserved IN (0, 1)),
      labels TEXT NOT NULL,
      max_concurrent_sessions INTEGER CHECK (max_concurrent_sessions >= 1),
      credential_hash TEXT NOT NULL,
      binary_version TEXT,
      protocol_version INTEGER,
      negotiated_capabilities TEXT,
      facts TEXT,
      watermark TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The oldest row of a name keeps it; every later one is renamed.
  yield* sql`
    INSERT INTO runners_new
      (id, name, connectivity, lifecycle, reserved, labels, max_concurrent_sessions,
       credential_hash, binary_version, protocol_version, negotiated_capabilities,
       facts, watermark, last_seen_at, created_at, updated_at)
    SELECT
      id,
      CASE WHEN rank = 1 THEN name
           ELSE 'runner-' || substr(lower(hex(id)), -8) END,
      CASE WHEN state IN ('online', 'offline', 'unreachable') THEN state ELSE 'offline' END,
      CASE WHEN state IN ('draining', 'retired') THEN state ELSE 'active' END,
      0, labels, NULL,
      credential_hash, binary_version, protocol_version, negotiated_capabilities,
      facts, watermark, last_seen_at, created_at, updated_at
    FROM (
      SELECT *, row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS rank
      FROM runners
    )
  `;

  const renamed = yield* sql<{
    readonly was: string;
    readonly now: string;
  }>`SELECT old.name AS was, new.name AS now
     FROM runners_new new JOIN runners old ON old.id = new.id
     WHERE old.name <> new.name`;
  for (const row of renamed) {
    yield* Effect.logWarning(
      `Two runners were named ${row.was}; this one is now ${row.now}. Rename it to something you recognise.`,
    );
  }

  // A cap of 1 is what every join wrote, so only a different number was a choice.
  const discarded = yield* sql<{
    readonly name: string;
    readonly max_concurrent_sessions: number;
  }>`SELECT name, max_concurrent_sessions FROM runners WHERE max_concurrent_sessions <> 1`;
  for (const row of discarded) {
    yield* Effect.logWarning(
      `The session cap of ${String(row.max_concurrent_sessions)} on ${row.name} is discarded; ` +
        `the cap is derived from the memory the machine reports until you set it again.`,
    );
  }

  yield* sql`DROP TABLE runners`;
  yield* sql`ALTER TABLE runners_new RENAME TO runners`;

  // Unique because renaming is one click on the runner page, and a fleet with
  // two machines of the same name is hard to talk about. One column is enough
  // for keyset paging: a unique name is already a total order, so the id in
  // the cursor never has to break a tie.
  yield* sql`CREATE UNIQUE INDEX runners_name ON runners (name)`;
  yield* sql`CREATE UNIQUE INDEX runners_credential_hash ON runners (credential_hash)`;
});
