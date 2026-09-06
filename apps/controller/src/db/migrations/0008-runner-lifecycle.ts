/**
 * The fleet's two axes, the reserved flag and a fleet-wide unique name.
 *
 * `state` held five values answering two questions that move independently:
 * whether the controller can reach the machine, and where the machine stands
 * with its owner. They split into `connectivity` and `lifecycle`.
 *
 * `max_concurrent_sessions` becomes nullable, `NULL` meaning derived from the
 * reported memory at read time. Facts first arrive at hello rather than at
 * join, so nothing can be derived at insert; every existing row is set to
 * `NULL`, and a cap that was set through the API is logged as it is discarded.
 *
 * Names were never unique, so the index below could find a fleet holding two of
 * one name. The later rows are renamed rather than the boot refused, since a
 * duplicate name is the user's to sort out. A rename takes the last eight hex
 * digits of the row's id, which are the random ones: a UUIDv7 spends its first
 * twelve on a millisecond clock. The name it lost is logged, because nothing
 * else would say what the machine used to be called. The boot still refuses if
 * that name is taken.
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

  // Unique because a rename is a click away on the runner page, and two
  // machines answering to one name is a fleet nobody can talk about. One column
  // is enough for the keyset walk the cursor drives: a unique name is already a
  // total order, so the id in the cursor never has to break a tie.
  yield* sql`CREATE UNIQUE INDEX runners_name ON runners (name)`;
  yield* sql`CREATE UNIQUE INDEX runners_credential_hash ON runners (credential_hash)`;
});
