/**
 * Adds the Skill Library (spec 04 "Skill rows"): `skills`, one row per Skill,
 * and `skill_revisions`, one row per Skill Revision.
 *
 * A revision's files are not rows. They live in the Data Root at
 * `skills/<hash>/`, a path that follows from the hash.
 *
 * `current_revision_hash` and `available_revision_hash` each name a revision
 * of the same Skill. No foreign key enforces that: the two tables would
 * reference each other, so every insert and every delete would need a
 * temporary null to get past the other table's key. The skills service keeps
 * the rule instead, and clears a hash before it deletes the revision the hash
 * names.
 *
 * A revision's hash is not unique across the table. Two Skills with the same
 * content each hold a revision with that hash, and both share one folder.
 * That is why the hash has an index of its own: a cleanup asks whether any
 * row still names a hash before it removes the folder.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE skills (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      current_revision_hash TEXT,
      available_revision_hash TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      last_checked_at TEXT,
      check_error TEXT,
      -- An update that is already current is no update. When the current
      -- hash is null the comparison is null, which a check lets through.
      CHECK (available_revision_hash IS NULL OR available_revision_hash <> current_revision_hash)
    )
  `;

  yield* sql`
    CREATE TABLE skill_revisions (
      skill_id BLOB NOT NULL REFERENCES skills (id),
      hash TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('import', 'github', 'session')),
      file_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      description TEXT NOT NULL,
      allowed_tools TEXT,
      hooks TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      applied_at TEXT,
      applied_by TEXT,
      includes_third_party_content INTEGER NOT NULL DEFAULT 0
        CHECK (includes_third_party_content IN (0, 1)),
      CHECK ((applied_at IS NULL) = (applied_by IS NULL)),
      PRIMARY KEY (skill_id, hash)
    )
  `;
  yield* sql`CREATE INDEX skill_revisions_hash ON skill_revisions (hash)`;
});
