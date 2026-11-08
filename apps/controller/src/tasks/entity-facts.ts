/**
 * The rows behind stage facts: the facts themselves (`task_entity_facts`), the
 * links a person took away (`task_entity_link_suppressions`), the fence and the
 * cause on each Task, and the reads of live links that writing a fact needs.
 *
 * A fact says that a linked External Entity changed in a way that may move its
 * Task. Its `id` is its order: there is one writer, so ids follow commit order
 * and nothing compares timestamps. This module only reads and writes rows. The
 * rules (when a fact is written, what a stage write does with the fence) live
 * in the Task service.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityLifecycle } from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { LIVE_TASK_LINKS_SQL, JOINABLE_TASK_SQL } from "./repository";

/** The most refs one statement lists links for, well under SQLite's limit on bound values. */
const MAX_REFS_PER_STATEMENT = 500;

/** One fact, as the row holds it. */
export interface EntityFact {
  readonly id: number;
  readonly taskId: string;
  readonly ref: string;
  readonly lifecycle: EntityLifecycle;
  /** Null when the thing was only just linked or observed. */
  readonly previousLifecycle: EntityLifecycle | null;
  /** When the thing was observed in this state. For display: it is never compared. */
  readonly observedAt: string;
  /** Set when the user unlinked the pair. A voided fact never moves a stage, but is still read for its words. */
  readonly voidedAt: string | null;
}

/** A fact to write. */
export type NewEntityFact = Omit<EntityFact, "id" | "voidedAt">;

/** A Task and a thing outside Hercule it links, or that a scan matched to it. */
export interface EntityLinkPair {
  readonly taskId: string;
  readonly ref: string;
}

interface FactRow {
  readonly id: number;
  readonly task_id: Uint8Array;
  readonly ref: string;
  readonly lifecycle: EntityLifecycle;
  readonly previous_lifecycle: EntityLifecycle | null;
  readonly observed_at: string;
  readonly voided_at: string | null;
}

const buildFact = (row: FactRow): EntityFact => ({
  id: row.id,
  taskId: uuidToString(row.task_id),
  ref: row.ref,
  lifecycle: row.lifecycle,
  previousLifecycle: row.previous_lifecycle,
  observedAt: row.observed_at,
  voidedAt: row.voided_at,
});

/** Orders links by Task id, then ref, the way text sorts. */
const sortLinks = (links: ReadonlyArray<EntityLinkPair>): ReadonlyArray<EntityLinkPair> =>
  links.toSorted((left, right) =>
    left.taskId === right.taskId
      ? left.ref < right.ref
        ? -1
        : left.ref > right.ref
          ? 1
          : 0
      : left.taskId < right.taskId
        ? -1
        : 1,
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Writes a fact and returns its id. Run it in the transaction of the change it reports. */
    insertFact: (fact: NewEntityFact): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          INSERT INTO task_entity_facts (task_id, ref, lifecycle, previous_lifecycle, observed_at)
          VALUES (${uuidFromString(fact.taskId)}, ${fact.ref}, ${fact.lifecycle},
                  ${fact.previousLifecycle}, ${fact.observedAt})
          RETURNING id`,
        (rows) => rows[0]!.id,
      ),

    /** Returns the fact with this id, voided or not, or none. */
    readFact: (id: number): Effect.Effect<Option.Option<EntityFact>, SqlError> =>
      Effect.map(
        sql<FactRow>`
          SELECT id, task_id, ref, lifecycle, previous_lifecycle, observed_at, voided_at
          FROM task_entity_facts WHERE id = ${id}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), buildFact),
      ),

    /** Voids every fact of the pair that is not voided yet. A voided fact stays readable but moves no stage. */
    voidFacts: (taskId: string, ref: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE task_entity_facts SET voided_at = ${at}
        WHERE task_id = ${uuidFromString(taskId)} AND ref = ${ref} AND voided_at IS NULL`),

    /**
     * Returns the facts with these ids, by id, voided ones included: a voided
     * fact still says why a card is where it is. An id with no fact is left
     * out. One statement however many ids there are.
     */
    listFacts: (
      factIds: ReadonlyArray<number>,
    ): Effect.Effect<ReadonlyMap<number, EntityFact>, SqlError> =>
      factIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<FactRow>`
              SELECT id, task_id, ref, lifecycle, previous_lifecycle, observed_at, voided_at
              FROM task_entity_facts WHERE id IN ${sql.in(factIds)}`,
            (rows) => new Map(rows.map((row) => [row.id, buildFact(row)])),
          ),

    /** Returns the highest fact id in the table, or 0 when there is none. */
    readHighestFactId: (): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly highest: number }>`
          SELECT COALESCE(MAX(id), 0) AS highest FROM task_entity_facts`,
        (rows) => rows[0]!.highest,
      ),

    /** Records that the user unlinked the pair, so no scan adds the link back. Does nothing if it is recorded already. */
    suppress: (
      taskId: string,
      ref: string,
      at: string,
      actor: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO task_entity_link_suppressions (task_id, ref, suppressed_at, suppressed_by)
        VALUES (${uuidFromString(taskId)}, ${ref}, ${at}, ${actor})
        ON CONFLICT (task_id, ref) DO NOTHING`),

    /** Removes the record of an unlink, because someone asked for the link again. */
    unsuppress: (taskId: string, ref: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        DELETE FROM task_entity_link_suppressions
        WHERE task_id = ${uuidFromString(taskId)} AND ref = ${ref}`),

    /**
     * Gives the survivor of a merge the facts and the unlink records of the
     * merged Task. A fact keeps its `voided_at`, so a fact the user voided
     * stays voided. A ref both Tasks had unlinked is recorded once, as the
     * survivor had it. Then the survivor's unlink record of any ref it links
     * now is dropped: merging brings the links together, and a link wins
     * over an old unlink.
     */
    moveFactsAndSuppressions: (sourceId: string, targetId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const source = uuidFromString(sourceId);
        const target = uuidFromString(targetId);
        yield* sql`UPDATE task_entity_facts SET task_id = ${target} WHERE task_id = ${source}`;
        yield* sql`
          INSERT INTO task_entity_link_suppressions (task_id, ref, suppressed_at, suppressed_by)
          SELECT ${target}, ref, suppressed_at, suppressed_by
          FROM task_entity_link_suppressions WHERE task_id = ${source}
          ON CONFLICT (task_id, ref) DO NOTHING`;
        yield* sql`DELETE FROM task_entity_link_suppressions WHERE task_id = ${source}`;
        yield* sql`
          DELETE FROM task_entity_link_suppressions
          WHERE task_id = ${target}
            AND ref IN (SELECT ref FROM task_entity_links WHERE task_id = ${target})`;
      }),

    /** Returns true when the user unlinked the pair and nobody has linked it again. */
    isSuppressed: (taskId: string, ref: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`
          SELECT 1 FROM task_entity_link_suppressions
          WHERE task_id = ${uuidFromString(taskId)} AND ref = ${ref}`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the live links to any of `refs`, as `(Task, ref)` pairs sorted by
     * Task and ref. A link is live by `LIVE_TASK_LINKS_SQL`: the one definition
     * of a joinable Task. One statement for each 500 refs, and none for no
     * refs. The refs are listed in the statement, not read from a subquery, so
     * SQLite narrows the links by the index on `ref` before it numbers them; a
     * subquery would make every poll read every link.
     */
    listLiveLinksTo: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<EntityLinkPair>, SqlError> =>
      Effect.map(
        Effect.forEach(
          Arr.chunksOf(refs, MAX_REFS_PER_STATEMENT),
          (chunk) =>
            sql<{ readonly task_id: Uint8Array; readonly ref: string }>`
              SELECT task_id, ref FROM (${sql.literal(LIVE_TASK_LINKS_SQL)})
              WHERE ref IN ${sql.in(chunk)}`,
        ),
        (chunks) =>
          sortLinks(
            chunks.flat().map((row) => ({ taskId: uuidToString(row.task_id), ref: row.ref })),
          ),
      ),

    /** Returns every live link of every live Task, sorted by Task and ref. */
    listAllLiveLinks: (): Effect.Effect<ReadonlyArray<EntityLinkPair>, SqlError> =>
      Effect.map(
        sql<{ readonly task_id: Uint8Array; readonly ref: string }>`
          SELECT task_id, ref FROM (${sql.literal(LIVE_TASK_LINKS_SQL)})`,
        (rows) =>
          sortLinks(rows.map((row) => ({ taskId: uuidToString(row.task_id), ref: row.ref }))),
      ),

    /**
     * Returns the refs the Task links when the Task is live, and none when it
     * is deleted, merged or finished. The Task is taken as it is. It reads by
     * the key on the Task id: `LIVE_TASK_LINKS_SQL` ranks links by ref, and
     * SQLite cannot narrow that ranking by Task.
     */
    listLiveLinkRefsOf: (taskId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly ref: string }>`
          SELECT l.ref FROM task_entity_links l JOIN tasks ON tasks.id = l.task_id
          WHERE l.task_id = ${uuidFromString(taskId)} AND ${sql.literal(JOINABLE_TASK_SQL)}
          ORDER BY l.ref`,
        (rows) => rows.map((row) => row.ref),
      ),
  };
});

export const entityFactRepository = make;
