/**
 * Adds the tables of External Entities (the Inbox), and the relation from a
 * Task to the refs it links.
 *
 * - `external_entities` has one row per canonical External Ref, `UNIQUE (ref)`.
 *   The row holds what a card draws: the slots the core renders from the
 *   kind's table (`identifier`, `status`, `person`, `owner`, `facts`) and a
 *   copy of the kind's `noun`, `card`, `pace` and `patience`, so a card still
 *   draws after its plugin is gone. A partial record (`completeness =
 *   'partial'`) knows only `kind`, `ref` and `title`, and a context record such
 *   as a repository has no card, no pace and no lifecycle, so every slot that
 *   only a work record fills is nullable. Structured slots are JSON text.
 *   `home` and `section` are copies of the kind's qualified words of the same
 *   names. `concerned_since` is when the entity last went from having no
 *   concern to having one: the start of the wait a card shows when the source
 *   does not report `waitingSince`. `concern_reasons` holds the sentence the
 *   kind declares for each concern it has a reason for, rendered for this
 *   thing, so a card can say why it concerns the user when the source names no
 *   reason of its own. `restored_at` and `restored_by` record who last brought
 *   a dismissed card back, as `dismissed_by` records who set it aside.
 * - `external_entity_observations` has one row per ref and Connection: the
 *   concerns that Connection reported, whether its latest inventory lists the
 *   ref (`listed`, true also for a place that concerns no one), and whether it
 *   can read the ref. It keys on the ref, not on the entity, so a Connection
 *   can hold state for a ref that has no entity yet. Deleting a Connection
 *   deletes its rows, and sets `presented_by` to NULL on the entities it
 *   presented.
 * - `external_entity_scans` has one row per Connection and kind: when its
 *   inventory was last read completely.
 * - `external_entity_ingest_warnings` has one row per Connection and kind
 *   whose latest inventory left something unresolved (a partial read, or a
 *   refused relationship). The Connection has one warning shared with account
 *   setup, so these rows are what lets the warning stay until every kind
 *   has resolved its own.
 * - `external_entity_relation_claims` has one row per claim of a relation
 *   (`part-of` or `linked`) between two refs. Each claim type has its own
 *   partial unique index, because SQLite treats NULLs as distinct, so a
 *   single unique key over `connection_id` and `actor` would not stop a repeat.
 * - `external_entity_arrival_counter` is the allocator of
 *   `external_entities.arrival_sequence`. It is a table of its own, so a
 *   number is never given twice, even after pruning deletes the entity that
 *   held the highest one.
 * - `task_entity_links` has one row per Task and linked ref. It keys on the
 *   ref, not on an entity, so a link outlives the pruning of the entity.
 *   Existing links are backfilled from the provenance of Tasks that are not
 *   deleted: the oldest entry of each (Task, ref) pair gives `linked_at` and
 *   `linked_by`. Provenance stays the history, and the link is the relation.
 * - `tasks.revision` counts the writes of an edit to a Task, 0 for a Task nobody
 *   has edited. Taking back a Task made for an outside thing asks whether it is
 *   still 0, which `updated_at` cannot answer when an edit lands in the same
 *   millisecond as the creation or the clock steps back.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE external_entities (
      id BLOB PRIMARY KEY NOT NULL,
      ref TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      noun TEXT NOT NULL,
      card TEXT CHECK (card IN ('rich', 'compact')),
      pace TEXT CHECK (pace IN ('fast', 'slow', 'context')),
      patience INTEGER,
      caption TEXT,
      home TEXT,
      section TEXT,
      completeness TEXT NOT NULL CHECK (completeness IN ('full', 'partial')),
      identifier TEXT,
      title TEXT NOT NULL,
      url TEXT,
      status TEXT CHECK (status IS NULL OR json_valid(status)),
      lifecycle TEXT CHECK (lifecycle IN ('open', 'completed', 'abandoned')),
      person TEXT CHECK (person IS NULL OR json_valid(person)),
      owner TEXT,
      facts TEXT CHECK (facts IS NULL OR json_valid(facts)),
      repository TEXT CHECK (repository IS NULL OR json_valid(repository)),
      reason TEXT CHECK (reason IS NULL OR json_valid(reason)),
      concern_reasons TEXT CHECK (concern_reasons IS NULL OR json_valid(concern_reasons)),
      progress TEXT CHECK (progress IS NULL OR json_valid(progress)),
      target_date TEXT,
      waiting_since TEXT,
      source_updated_at TEXT,
      source_revision TEXT,
      concerned_since TEXT,
      first_observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      presented_by BLOB REFERENCES connections (id) ON DELETE SET NULL,
      dismissed_at TEXT,
      dismissed_by TEXT,
      restored_at TEXT,
      restored_by TEXT,
      arrival_sequence INTEGER
    )
  `;

  yield* sql`
    CREATE TABLE external_entity_arrival_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last INTEGER NOT NULL
    )
  `;
  yield* sql`INSERT INTO external_entity_arrival_counter (id, last) VALUES (1, 0)`;

  yield* sql`
    CREATE TABLE external_entity_observations (
      ref TEXT NOT NULL,
      connection_id BLOB NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
      concerns TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(concerns)),
      listed INTEGER NOT NULL DEFAULT 0,
      owned_by_you INTEGER NOT NULL DEFAULT 0,
      access TEXT NOT NULL DEFAULT 'ok' CHECK (access IN ('ok', 'inaccessible', 'deleted')),
      last_attempted_at TEXT,
      last_refreshed_at TEXT,
      next_attempt_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ref, connection_id)
    ) WITHOUT ROWID
  `;
  // Serves the refs a Connection still lists in its inventory, and what a
  // complete inventory then leaves out.
  yield* sql`
    CREATE INDEX external_entity_observations_listed
      ON external_entity_observations (connection_id, ref) WHERE listed = 1
  `;
  // Serves the question "which refs concern the user", asked by the Inbox,
  // the wanted refs and the prune.
  yield* sql`
    CREATE INDEX external_entity_observations_concerned
      ON external_entity_observations (ref) WHERE concerns <> '[]'
  `;
  // Serves the durable rotation of `listWanted`: never tried first, then the
  // oldest attempt.
  yield* sql`
    CREATE INDEX external_entity_observations_attempted
      ON external_entity_observations (connection_id, last_attempted_at)
  `;

  yield* sql`
    CREATE TABLE external_entity_scans (
      connection_id BLOB NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      last_complete_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      PRIMARY KEY (connection_id, kind)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE external_entity_ingest_warnings (
      connection_id BLOB NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      warning TEXT NOT NULL,
      PRIMARY KEY (connection_id, kind)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE external_entity_relation_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ref TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('part-of', 'linked')),
      to_ref TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK (claim_type IN ('source', 'person', 'text')),
      connection_id BLOB REFERENCES connections (id) ON DELETE CASCADE,
      actor TEXT,
      evidence_key TEXT NOT NULL,
      observed_revision TEXT,
      state TEXT NOT NULL CHECK (state IN ('current', 'conflicted')),
      conflict_reason TEXT,
      observed_at TEXT NOT NULL,
      CHECK (claim_type <> 'person' OR (actor IS NOT NULL AND connection_id IS NULL)),
      CHECK (claim_type = 'person' OR (connection_id IS NOT NULL AND actor IS NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX external_entity_claims_source_ref
      ON external_entity_relation_claims (from_ref, relation, to_ref, connection_id)
      WHERE claim_type = 'source' AND evidence_key = ''
  `;
  yield* sql`
    CREATE UNIQUE INDEX external_entity_claims_source_url
      ON external_entity_relation_claims (from_ref, relation, connection_id, evidence_key)
      WHERE claim_type = 'source' AND evidence_key <> ''
  `;
  yield* sql`
    CREATE UNIQUE INDEX external_entity_claims_text
      ON external_entity_relation_claims (from_ref, relation, to_ref, connection_id, evidence_key)
      WHERE claim_type = 'text'
  `;
  yield* sql`
    CREATE UNIQUE INDEX external_entity_claims_person
      ON external_entity_relation_claims (from_ref, relation, to_ref, actor)
      WHERE claim_type = 'person'
  `;
  // Serve the read of the claims the graph refused, by either end.
  yield* sql`
    CREATE INDEX external_entity_claims_conflicted_from
      ON external_entity_relation_claims (from_ref) WHERE state = 'conflicted'
  `;
  yield* sql`
    CREATE INDEX external_entity_claims_conflicted_to
      ON external_entity_relation_claims (to_ref) WHERE state = 'conflicted'
  `;
  // Serve the walk up from a ref (`readAncestors`), which also reads the
  // first parents of a ref in order of `to_ref` without a sort, and the walk down.
  yield* sql`
    CREATE INDEX external_entity_claims_from
      ON external_entity_relation_claims (from_ref, relation, to_ref) WHERE state = 'current'
  `;
  yield* sql`
    CREATE INDEX external_entity_claims_to
      ON external_entity_relation_claims (to_ref, relation) WHERE state = 'current'
  `;

  yield* sql`ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`;

  yield* sql`
    CREATE TABLE task_entity_links (
      task_id BLOB NOT NULL REFERENCES tasks (id),
      ref TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      linked_by TEXT NOT NULL,
      following INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, ref)
    ) WITHOUT ROWID
  `;
  // Serves the active Task of a ref: the live Task with the lowest
  // `(linked_at, task_id)`, read in index order.
  yield* sql`CREATE INDEX task_entity_links_ref ON task_entity_links (ref, linked_at, task_id)`;

  // The oldest entry of each pair, by time and then by append order.
  yield* sql`
    INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
    SELECT task_id, ref, at, actor, 0 FROM (
      SELECT p.task_id, p.ref, p.at, p.actor,
             ROW_NUMBER() OVER (PARTITION BY p.task_id, p.ref ORDER BY p.at, p.rowid) AS position
      FROM task_provenance p JOIN tasks t ON t.id = p.task_id
      WHERE p.ref IS NOT NULL AND t.deleted_at IS NULL
    ) WHERE position = 1
  `;
});
