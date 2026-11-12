/**
 * The typed fields of External Entities in the database: the one place their
 * rows (`external_entity_fields`, keyed by `(ref, key)`) are read, replaced
 * and swept. What a row means is `field-values.ts`; nothing here interprets
 * a value.
 *
 * A full observation replaces the whole set of rows of its ref.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { CardFace, EntityFieldValue } from "@hercule/contract";
import type { ActiveEntityKind } from "./entity-records";
import { decodeEntityFields, type EncodedField, type TitledField } from "./field-values";

/** One stored field value, as read from `external_entity_fields`. */
interface StoredFieldRow extends EncodedField {
  readonly ref: string;
}

/** The encoded fields of one accepted full observation: the whole set its ref now holds. */
export interface FieldSet {
  readonly ref: string;
  readonly fields: ReadonlyArray<EncodedField>;
}

/** The field values and card face of one entity, as `decodeEntityFields` returns them. */
export interface EntityFieldValues {
  readonly fields: EntityFieldValue[];
  readonly face: CardFace | null;
}

/** What `diffFieldRows` decides to write. */
interface FieldRowChanges {
  readonly upserts: ReadonlyArray<StoredFieldRow>;
  readonly deletes: ReadonlyArray<{ readonly ref: string; readonly key: string }>;
  /** The refs with at least one upsert or delete, sorted. */
  readonly changedRefs: ReadonlyArray<string>;
}

/**
 * Compares the new set of each ref with what is stored and returns only the
 * difference: rows that are new or have another value, and stored rows of
 * the ref that the new set no longer has. A ref whose set equals its stored
 * rows is not in the result.
 */
const diffFieldRows = (
  sets: ReadonlyArray<FieldSet>,
  stored: ReadonlyArray<StoredFieldRow>,
): FieldRowChanges => {
  const storedByRef = new Map<string, Map<string, StoredFieldRow>>();
  for (const row of stored) {
    const rows = storedByRef.get(row.ref) ?? new Map<string, StoredFieldRow>();
    rows.set(row.key, row);
    storedByRef.set(row.ref, rows);
  }
  const upserts: Array<StoredFieldRow> = [];
  const deletes: Array<{ ref: string; key: string }> = [];
  const changedRefs = new Set<string>();
  for (const { ref, fields } of sets) {
    const rows = storedByRef.get(ref) ?? new Map<string, StoredFieldRow>();
    const kept = new Set<string>();
    for (const field of fields) {
      kept.add(field.key);
      const old = rows.get(field.key);
      if (
        old === undefined ||
        old.text_value !== field.text_value ||
        old.number_value !== field.number_value
      ) {
        upserts.push({ ref, ...field });
        changedRefs.add(ref);
      }
    }
    for (const key of rows.keys()) {
      if (kept.has(key)) continue;
      deletes.push({ ref, key });
      changedRefs.add(ref);
    }
  }
  return { upserts, deletes, changedRefs: [...changedRefs].sort() };
};

/**
 * Reads the stored field rows of `refs` in one statement, ordered by ref and
 * then key. It reads nothing but the field table, so the ingest's comparison
 * on every poll stays cheap.
 */
const readStoredFieldRows = (
  refs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<StoredFieldRow>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (refs.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<StoredFieldRow>`
      SELECT ref, key, text_value, number_value FROM external_entity_fields
      WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
      ORDER BY ref, key`;
  });

/** One row of the read of `readFieldValues`: a field of an entity, or the entity alone when it has no field rows. */
interface EntityFieldRow {
  readonly ref: string;
  readonly kind: string;
  readonly key: string | null;
  readonly text_value: string | null;
  readonly number_value: number | null;
  readonly title: string | null;
}

/**
 * Reads the field values and card face of each of `refs`, in one statement
 * however many refs there are. Returns a map with one entry for every ref
 * that has an entity, including an entity with no field rows. A ref with no
 * entity is not in the map. `kinds` are the active kinds: each entity is
 * decoded with the kind it was stored with, so the read joins the entity for
 * its `kind` and does not guess it from the ref's prefix. An entity whose
 * kind is not in `kinds` gets no fields and no face (`decodeEntityFields`).
 *
 * A field whose text is the ref of another record shows that record's title,
 * which is null when no such record exists and when no Connection reads it
 * now (some observation of it has `access = 'ok'`, the rule of
 * `deriveAccess`), so a place nobody can read never shows its title.
 */
export const readFieldValues = (
  refs: ReadonlyArray<string>,
  kinds: ReadonlyArray<ActiveEntityKind> | undefined,
): Effect.Effect<ReadonlyMap<string, EntityFieldValues>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const values = new Map<string, EntityFieldValues>();
    if (refs.length === 0) return values;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<EntityFieldRow>`
      SELECT e.ref AS ref, e.kind AS kind, f.key AS key,
             f.text_value AS text_value, f.number_value AS number_value, t.title AS title
      FROM external_entities e
      LEFT JOIN external_entity_fields f ON f.ref = e.ref
      LEFT JOIN external_entities t
        ON t.ref = f.text_value
        AND EXISTS (SELECT 1 FROM external_entity_observations o
                    WHERE o.ref = t.ref AND o.access = 'ok')
      WHERE e.ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
      ORDER BY e.ref, f.key`;
    const byRef = new Map<string, { kind: string; fields: Array<TitledField> }>();
    for (const row of rows) {
      const entity = byRef.get(row.ref) ?? { kind: row.kind, fields: [] };
      byRef.set(row.ref, entity);
      if (row.key !== null) entity.fields.push({ ...row, key: row.key });
    }
    for (const [ref, { kind, fields }] of byRef) {
      values.set(
        ref,
        decodeEntityFields(
          kinds?.find((entry) => entry.kind === kind),
          fields,
        ),
      );
    }
    return values;
  });

/**
 * Makes the stored rows of each `FieldSet`'s ref equal its fields. Reads the
 * stored rows of those refs in one statement, then writes only the
 * difference, in at most two statements however many refs there are. Call it
 * inside the transaction of the write it belongs to. Returns the refs whose
 * rows changed, sorted.
 */
export const replaceFieldRows = (
  sets: ReadonlyArray<FieldSet>,
): Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const stored = yield* readStoredFieldRows(sets.map(({ ref }) => ref));
    const changes = diffFieldRows(sets, stored);
    if (changes.changedRefs.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    if (changes.upserts.length > 0) {
      // `WHERE true` keeps SQLite from reading `ON CONFLICT` as part of a join.
      yield* sql`
        INSERT INTO external_entity_fields (ref, key, text_value, number_value)
        SELECT json_extract(value, '$.ref'), json_extract(value, '$.key'),
               json_extract(value, '$.text_value'), json_extract(value, '$.number_value')
        FROM json_each(${JSON.stringify(changes.upserts)}) WHERE true
        ON CONFLICT (ref, key) DO UPDATE SET
          text_value = excluded.text_value, number_value = excluded.number_value`;
    }
    if (changes.deletes.length > 0) {
      yield* sql`
        DELETE FROM external_entity_fields
        WHERE (ref, key) IN (
          SELECT json_extract(value, '$.ref'), json_extract(value, '$.key')
          FROM json_each(${JSON.stringify(changes.deletes)}))`;
    }
    return changes.changedRefs;
  });

/** Deletes the field rows of refs that have no entity. The prune sweep calls it. */
export const deleteOrphanedFields = (): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM external_entity_fields
      WHERE NOT EXISTS (SELECT 1 FROM external_entities e WHERE e.ref = external_entity_fields.ref)`;
  });
