/**
 * The timeline of an External Entity: what changed at the source, kept as a
 * short list of facts and put into words when it is read.
 *
 * Three things are news:
 *
 * - `reassigned`: the kind's `owner` field now names someone else.
 * - `moved`: the status now has a different word.
 * - `linked`: a new link to another thing arrived.
 *
 * The system shows these and acts on nothing. This file never moves a card,
 * ends a signal, raises an event or touches a Task.
 *
 * A row stores the raw facts (`person`, `value`). The sentence is built at
 * read time from the `reason_templates` copied onto the entity at
 * observation, else from the core's own words, so it reads well after the
 * plugin is gone.
 */
import { MAX_ENTITY_TIMELINE, type EntityChange } from "@hercule/contract";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { NewLink } from "./claim-sql";
import { parseStoredStatus, type EntityRow, type SharedValues } from "./entity-records";
import { fillSentence, parseReasonTemplates, renderSentence } from "./sentences";

/** The three kinds of news a timeline holds. */
export type EntityChangeReason = EntityChange["reason"];

/**
 * One thing to write on a timeline. `person` is the new owner of a
 * `reassigned` change. `value` is the new status word of a `moved` change,
 * and the words for what the thing was linked to for a `linked` change, whose
 * `targetRef` is the linked thing's ref.
 */
export interface EntityChangeRecord {
  readonly ref: string;
  readonly reason: EntityChangeReason;
  readonly person?: string;
  readonly value?: string;
  /** For a `linked` change, the ref of the linked thing. */
  readonly targetRef?: string;
}

/** The sentences the core uses when the kind declares none for a reason. */
const DEFAULT_SENTENCES: Readonly<Record<EntityChangeReason, string>> = {
  reassigned: "Now with {person}",
  moved: "Moved to {value}",
  linked: "Linked {value}",
};

/** One row of the timeline table, with the templates of the entity it belongs to. */
interface TimelineRow {
  readonly reason: EntityChangeReason;
  readonly person: string | null;
  readonly value: string | null;
  readonly target_ref: string | null;
  readonly observed_at: string;
  readonly reason_templates: string | null;
}

/**
 * Returns the changes that an accepted update of the shared columns of an
 * existing entity makes news of, or an empty list.
 *
 * - `reassigned` when the update sets an owner that differs from the stored
 *   one. An update that clears the owner is not news.
 * - `moved` when the update sets a status whose word differs from the stored
 *   status word. It compares the words, because the status key is not stored.
 *   A thing with no status before is not news.
 * - A partial record that a full observation completes is a baseline, not
 *   news, because the columns it held before were only unknown.
 *
 * `changes` is the set of columns the update writes, as `decideSharedWrite`
 * computes it: only columns whose value differs are in it. Compares the raw
 * stored values and never a rendered sentence.
 */
export const detectSourceChanges = (input: {
  readonly ref: string;
  readonly existing: Pick<EntityRow, "completeness" | "owner" | "status">;
  readonly incomingIsPartial: boolean;
  readonly changes: Partial<SharedValues>;
}): ReadonlyArray<EntityChangeRecord> => {
  const { ref, existing, changes } = input;
  if (existing.completeness === "partial" && !input.incomingIsPartial) return [];
  const found: Array<EntityChangeRecord> = [];
  const owner = changes.owner;
  if (typeof owner === "string" && owner !== existing.owner) {
    found.push({ ref, reason: "reassigned", person: owner });
  }
  if (typeof changes.status === "string") {
    const before = parseStoredStatus(existing.status as string | null).status;
    const after = parseStoredStatus(changes.status).status;
    if (before !== undefined && after !== undefined && before.label !== after.label) {
      found.push({ ref, reason: "moved", value: after.label });
    }
  }
  return found;
};

/**
 * Builds the public change for one stored row. The sentence comes from the
 * kind's template for the row's reason when it has one that can be filled,
 * else from the core's default. The tone is the template's, else `plain`. The
 * sentence is cut at a word to the bound of `EntityReason.say`.
 *
 * The writer always stores the person of a `reassigned` row and the value of
 * the other two, so a missing fact reads as empty text.
 */
export const renderEntityChange = (row: TimelineRow): EntityChange => {
  const template = parseReasonTemplates(row.reason_templates)?.[row.reason];
  const facts = { person: row.person ?? "", value: row.value ?? "" };
  return {
    reason: row.reason,
    say: renderSentence(template, facts, fillSentence(DEFAULT_SENTENCES[row.reason], facts)!),
    at: row.observed_at,
    ...(row.target_ref === null ? {} : { ref: row.target_ref }),
  };
};

const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Writes the changes on the timelines of their refs, all in one insert
   * stamped `now`, then keeps only the newest `MAX_ENTITY_TIMELINE` rows of
   * each ref they touch, with one delete. Joins the caller's transaction.
   * Several changes of one ref keep the order given.
   *
   * The shared write of an observation calls this for `reassigned` and
   * `moved` (see `detectSourceChanges`). `recordLinks` builds the `linked`
   * changes of new links.
   */
  const recordEntityChanges = (
    changes: ReadonlyArray<EntityChangeRecord>,
    now: string,
  ): Effect.Effect<void, SqlError> =>
    changes.length === 0
      ? Effect.void
      : Effect.gen(function* () {
          yield* sql`
            INSERT INTO external_entity_timeline (ref, reason, person, value, target_ref, observed_at)
            SELECT json_extract(value, '$.ref'), json_extract(value, '$.reason'),
                   json_extract(value, '$.person'), json_extract(value, '$.value'),
                   json_extract(value, '$.targetRef'), ${now}
            FROM json_each(${JSON.stringify(changes)})
            ORDER BY key`;
          yield* sql`
            DELETE FROM external_entity_timeline
            WHERE id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY ref ORDER BY id DESC) AS position
                FROM external_entity_timeline
                WHERE ref IN (SELECT value FROM json_each(${refsJson([...new Set(changes.map((change) => change.ref))])}))
              ) WHERE position > ${MAX_ENTITY_TIMELINE})`;
        });

  return {
    recordEntityChanges,

    /**
     * Writes a `linked` change on both ends of each pair, in the caller's
     * transaction: each thing's timeline names the other end, by its
     * identifier, else its noun, else by nothing when no record of it exists
     * yet. Pass only pairs that a source joined for the first time (see
     * `NewLink`): a person's own link is not news from outside.
     */
    recordLinks: (links: ReadonlyArray<NewLink>, now: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        if (links.length === 0) return;
        const refs = [...new Set(links.flatMap((link) => [link.fromRef, link.toRef]))];
        const rows = yield* sql<{
          readonly ref: string;
          readonly identifier: string | null;
          readonly noun: string | null;
        }>`
          SELECT ref, identifier, noun FROM external_entities
          WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`;
        const words = new Map(
          rows.map((row) => [row.ref, row.identifier ?? row.noun ?? undefined] as const),
        );
        const describeEnd = (ref: string, otherRef: string): EntityChangeRecord => {
          const value = words.get(otherRef);
          return {
            ref,
            reason: "linked",
            targetRef: otherRef,
            ...(value === undefined || value === "" ? {} : { value }),
          };
        };
        const changes = links.flatMap(({ fromRef, toRef }) => [
          describeEnd(fromRef, toRef),
          describeEnd(toRef, fromRef),
        ]);
        yield* recordEntityChanges(changes, now);
      }),

    /**
     * Returns the timeline of one ref in words, oldest first, at most
     * `MAX_ENTITY_TIMELINE` changes.
     */
    readTimeline: (ref: string): Effect.Effect<ReadonlyArray<EntityChange>, SqlError> =>
      Effect.map(
        sql<TimelineRow>`
          SELECT t.reason, t.person, t.value, t.target_ref, t.observed_at, e.reason_templates
          FROM external_entity_timeline t
          LEFT JOIN external_entities e ON e.ref = t.ref
          WHERE t.ref = ${ref}
          ORDER BY t.id DESC
          LIMIT ${MAX_ENTITY_TIMELINE}`,
        (rows) => rows.map(renderEntityChange).reverse(),
      ),

    /**
     * Returns the newest change of each of `refs` that has one, in words, in
     * one statement however many refs there are. A ref with no change is not
     * in the map.
     */
    readLatestChanges: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, EntityChange>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<TimelineRow & { readonly ref: string }>`
              SELECT t.ref, t.reason, t.person, t.value, t.target_ref, t.observed_at, e.reason_templates
              FROM (
                SELECT ref, MAX(id) AS id FROM external_entity_timeline
                WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))
                GROUP BY ref
              ) newest
              JOIN external_entity_timeline t ON t.id = newest.id
              LEFT JOIN external_entities e ON e.ref = t.ref`,
            (rows) => new Map(rows.map((row) => [row.ref, renderEntityChange(row)] as const)),
          ),

    /**
     * Deletes the timelines of refs that have no entity, and returns how many
     * rows it deleted. The sweep that prunes entities calls it, so a timeline
     * goes with its entity.
     */
    deleteOrphanedChanges: (): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql`
          DELETE FROM external_entity_timeline
          WHERE NOT EXISTS (SELECT 1 FROM external_entities e WHERE e.ref = external_entity_timeline.ref)
          RETURNING id`,
        (rows) => rows.length,
      ),
  };
});

/** Reads and writes the timelines of External Entities. */
export const timelineRepository = make;
