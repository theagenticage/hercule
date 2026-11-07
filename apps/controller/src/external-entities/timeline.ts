/**
 * The timeline of an External Entity: what changed at the source, kept as a
 * short list of facts and put into words when it is read.
 *
 * Three things are news:
 *
 * - `reassigned`: the kind's `owner` field now names someone else, or no one.
 * - `moved`: the status now has a different key.
 * - `linked`: a new link to another thing arrived.
 *
 * The system shows these and acts on nothing. This file never moves a card,
 * ends a signal, raises an event or touches a Task.
 *
 * A row stores the raw facts (`person`, `value`, `targetRef`). The sentence
 * is built at read time from the `reason_templates` copied onto the entity at
 * observation, else from the core's own words, so it reads well after the
 * plugin is gone.
 *
 * A `linked` row stores no words for the thing it links. They are worked out
 * at read time from what the user can open now, so a thing that became
 * inaccessible after the link was written is no longer named.
 */
import { MAX_ENTITY_TIMELINE, type EntityChange } from "@hercule/contract";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { NewLink } from "./claim-sql";
import {
  deriveAccess,
  findActiveKind,
  parseStoredStatus,
  type ActiveEntityKind,
  type EntityRow,
  type SharedValues,
} from "./entity-records";
import { fillSentence, parseReasonTemplates, renderSentence } from "./sentences";

/** The three kinds of news a timeline holds. */
export type EntityChangeReason = EntityChange["reason"];

/**
 * One thing to write on a timeline. `person` is the new owner of a
 * `reassigned` change, absent when the owner was cleared. `value` is the new
 * status word of a `moved` change. `targetRef` is the ref of the thing a
 * `linked` change joined.
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

/** The sentence the core uses for a cleared owner, and the key under which a kind may declare its own. */
const UNASSIGNED_SENTENCE = "Unassigned";
const UNASSIGNED_KEY = "unassigned";

/** What the timeline of a ref says about a thing it links when the user cannot open that thing and its kind is unknown. */
const UNKNOWN_NOUN = "thing";

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
 *   one, or clears an owner (a change with no `person`).
 * - `moved` when the update sets a status whose key differs from the stored
 *   key. The change carries the new status word. A thing with no status
 *   before is not news, and a status whose word was only renamed is not
 *   either.
 * - A partial record that a full observation completes is a baseline, not
 *   news, because the columns it held before were only unknown.
 *
 * `changes` is the set of columns the update writes, as `decideSharedWrite`
 * computes it: only columns whose value differs are in it. Compares the raw
 * stored values and never a rendered sentence.
 */
export const detectSourceChanges = (input: {
  readonly ref: string;
  readonly existing: Pick<EntityRow, "completeness" | "owner" | "status" | "status_key">;
  readonly incomingIsPartial: boolean;
  readonly changes: Partial<SharedValues>;
}): ReadonlyArray<EntityChangeRecord> => {
  const { ref, existing, changes } = input;
  if (existing.completeness === "partial" && !input.incomingIsPartial) return [];
  const found: Array<EntityChangeRecord> = [];
  const owner = changes.owner;
  if (typeof owner === "string" && owner !== existing.owner) {
    found.push({ ref, reason: "reassigned", person: owner });
  } else if (owner === null && existing.owner !== null) {
    found.push({ ref, reason: "reassigned" });
  }
  const statusKey = changes.status_key;
  if (
    typeof statusKey === "string" &&
    existing.status_key !== null &&
    statusKey !== existing.status_key
  ) {
    // The word does not change with the key when two keys share a word.
    const after = parseStoredStatus((changes.status ?? existing.status) as string | null).status;
    if (after !== undefined) found.push({ ref, reason: "moved", value: after.label });
  }
  return found;
};

/** Returns a noun with its article, lower-cased: "a pull request", "an issue". */
const describeThing = (noun: string): string => {
  const lower = noun.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
};

/**
 * Builds the public change for one stored row. The sentence comes from the
 * kind's template for the row's reason when it has one that can be filled,
 * else from the core's default. The tone is the template's, else `plain`. The
 * sentence is cut at a word to the bound of `EntityReason.say`.
 *
 * - A `reassigned` row without a person says the owner was cleared: the
 *   kind's `unassigned` template, else "Unassigned".
 * - A `linked` row takes its `{value}` from `linkedWords`, the words for the
 *   thing it links (see `readLinkedWords`). A missing value reads as empty.
 */
export const renderEntityChange = (row: TimelineRow, linkedWords?: string): EntityChange => {
  const templates = parseReasonTemplates(row.reason_templates);
  const cleared = row.reason === "reassigned" && row.person === null;
  const facts = {
    person: row.person ?? "",
    value: row.reason === "linked" ? (linkedWords ?? "") : (row.value ?? ""),
  };
  return {
    reason: row.reason,
    say: cleared
      ? renderSentence(templates?.[UNASSIGNED_KEY], {}, UNASSIGNED_SENTENCE)
      : renderSentence(
          templates?.[row.reason],
          facts,
          fillSentence(DEFAULT_SENTENCES[row.reason], facts)!,
        ),
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

  /**
   * Returns the words for each thing the `linked` rows join, by ref, in at
   * most two statements however many there are, and none when there is no
   * `linked` row.
   *
   * - A thing the user can open now (some Connection reads it) is named by
   *   its identifier, else "a <noun>".
   * - A thing the user cannot open, or that has no record, is "a <noun> you
   *   cannot open", with the noun of its record, else of the active kind
   *   whose `refPrefix` starts its ref, else "thing". It shows no identifier.
   */
  const readLinkedWords = (
    rows: ReadonlyArray<Pick<TimelineRow, "reason" | "target_ref">>,
    kinds: ReadonlyArray<ActiveEntityKind> | undefined,
  ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
    Effect.gen(function* () {
      const targets = [
        ...new Set(
          rows.flatMap((row) =>
            row.reason === "linked" && row.target_ref !== null ? [row.target_ref] : [],
          ),
        ),
      ];
      if (targets.length === 0) return new Map();
      const records = yield* sql<{
        readonly ref: string;
        readonly identifier: string | null;
        readonly noun: string | null;
      }>`
        SELECT ref, identifier, noun FROM external_entities
        WHERE ref IN (SELECT value FROM json_each(${refsJson(targets)}))`;
      const observations = yield* sql<{
        readonly ref: string;
        readonly access: "ok" | "inaccessible" | "deleted";
      }>`
        SELECT ref, access FROM external_entity_observations
        WHERE ref IN (SELECT value FROM json_each(${refsJson(targets)}))`;
      const recordsByRef = new Map(records.map((record) => [record.ref, record] as const));
      const accessByRef = new Map<
        string,
        Array<{ readonly access: "ok" | "inaccessible" | "deleted" }>
      >();
      for (const observation of observations) {
        const group = accessByRef.get(observation.ref);
        if (group === undefined) accessByRef.set(observation.ref, [observation]);
        else group.push(observation);
      }
      return new Map(
        targets.map((target) => {
          const record = recordsByRef.get(target);
          const noun = record?.noun ?? findActiveKind(kinds, target)?.noun ?? UNKNOWN_NOUN;
          const readable =
            record !== undefined && deriveAccess(accessByRef.get(target) ?? []) === "ok";
          return [
            target,
            readable
              ? (record.identifier ?? describeThing(noun))
              : `${describeThing(noun)} you cannot open`,
          ] as const;
        }),
      );
    });

  return {
    recordEntityChanges,

    /**
     * Writes a `linked` change on both ends of each pair, in the caller's
     * transaction. Each change holds the ref of the other end and no words:
     * they are worked out when the timeline is read. Pass only pairs that a
     * source joined for the first time (see `NewLink`): a person's own link
     * is not news from outside.
     */
    recordLinks: (links: ReadonlyArray<NewLink>, now: string): Effect.Effect<void, SqlError> =>
      recordEntityChanges(
        links.flatMap(({ fromRef, toRef }) => [
          { ref: fromRef, reason: "linked" as const, targetRef: toRef },
          { ref: toRef, reason: "linked" as const, targetRef: fromRef },
        ]),
        now,
      ),

    /**
     * Returns the timeline of one ref in words, oldest first, at most
     * `MAX_ENTITY_TIMELINE` changes. `kinds` name a linked thing that has no
     * record (see `readLinkedWords`).
     */
    readTimeline: (
      ref: string,
      kinds?: ReadonlyArray<ActiveEntityKind>,
    ): Effect.Effect<ReadonlyArray<EntityChange>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<TimelineRow>`
          SELECT t.reason, t.person, t.value, t.target_ref, t.observed_at, e.reason_templates
          FROM external_entity_timeline t
          LEFT JOIN external_entities e ON e.ref = t.ref
          WHERE t.ref = ${ref}
          ORDER BY t.id DESC
          LIMIT ${MAX_ENTITY_TIMELINE}`;
        const words = yield* readLinkedWords(rows, kinds);
        return rows
          .map((row) => renderEntityChange(row, words.get(row.target_ref ?? "")))
          .reverse();
      }),

    /**
     * Returns the newest change of each of `refs` that has one, in words, in
     * one statement however many refs there are, plus two more when a newest
     * change is a link (see `readLinkedWords`). A ref with no change is not in
     * the map.
     */
    readLatestChanges: (
      refs: ReadonlyArray<string>,
      kinds?: ReadonlyArray<ActiveEntityKind>,
    ): Effect.Effect<ReadonlyMap<string, EntityChange>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.gen(function* () {
            const rows = yield* sql<TimelineRow & { readonly ref: string }>`
              SELECT t.ref, t.reason, t.person, t.value, t.target_ref, t.observed_at, e.reason_templates
              FROM (
                SELECT ref, MAX(id) AS id FROM external_entity_timeline
                WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))
                GROUP BY ref
              ) newest
              JOIN external_entity_timeline t ON t.id = newest.id
              LEFT JOIN external_entities e ON e.ref = t.ref`;
            const words = yield* readLinkedWords(rows, kinds);
            return new Map(
              rows.map(
                (row) =>
                  [row.ref, renderEntityChange(row, words.get(row.target_ref ?? ""))] as const,
              ),
            );
          }),

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
