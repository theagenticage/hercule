/**
 * The typed fields of External Entities: how an observation's declared fields
 * become rows, and the one place those rows are read, written and swept.
 *
 * A kind declares its fields (`EntityKindDeclaration.fields`). A full
 * observation reports a value for each in `fields[key]`. A field with a value
 * is one row of `external_entity_fields`, keyed by `(ref, key)`, with its
 * value in exactly one column:
 *
 * - `text`, `person` and `enum` are stored in `text_value`.
 * - `number` and `money` are stored in `number_value`.
 * - `age` is stored in `number_value` as epoch milliseconds.
 * - `bool` is stored in `number_value` as 0 or 1.
 *
 * A field that is null or missing has no row. A full observation replaces the
 * whole set of rows of its ref.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  ISO_TIMESTAMP_PATTERN,
  type EntityObservation,
  type QualifiedEntityFieldDeclaration,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";

/** One stored field value, as read from `external_entity_fields`. */
export interface StoredFieldRow {
  readonly ref: string;
  readonly key: string;
  readonly text_value: string | null;
  readonly number_value: number | null;
}

/**
 * One stored field value with the title of the record it points at, as the
 * read of an entity needs it. `title` is not null only when `text_value` is
 * the ref of a record that some Connection reads now (the same rule as
 * `buildPlace`, which shows no title for a restricted place).
 */
export interface TitledFieldRow extends StoredFieldRow {
  readonly title: string | null;
}

/** The first and last instants whose year has four digits (0000 to 9999), which the contract's timestamp can write. */
const FIRST_AGE_MS = Date.parse("0000-01-01T00:00:00.000Z");
const LAST_AGE_MS = Date.parse("9999-12-31T23:59:59.999Z");

/** Checks that a stored age is an instant the contract can write as a timestamp (year 0000 to 9999). */
export const isRepresentableAge = (epochMs: number): boolean =>
  Number.isFinite(epochMs) && epochMs >= FIRST_AGE_MS && epochMs <= LAST_AGE_MS;

/**
 * Parses an ISO 8601 timestamp with a time zone into epoch milliseconds.
 * Returns undefined when the text is not in the form of `ISO_TIMESTAMP_PATTERN`,
 * names a date or time that does not exist (such as 2026-02-31, which
 * `Date.parse` would roll into March), or is outside the years 0000 to 9999.
 */
const parseIsoTimestamp = (text: string): number | undefined => {
  if (!ISO_TIMESTAMP_PATTERN.test(text)) return undefined;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  const moment = Date.parse(text);
  return isRepresentableAge(moment) ? moment : undefined;
};

/** One field value of an observation, encoded for storage. Exactly one value column is not null. */
export interface EncodedField {
  readonly key: string;
  readonly text_value: string | null;
  readonly number_value: number | null;
}

/** The encoded fields of one accepted full observation: the whole set its ref now holds. */
export interface FieldSet {
  readonly ref: string;
  readonly fields: ReadonlyArray<EncodedField>;
}

/** What `encodeObservedFields` returns: the rows to store, or why the observation is refused. */
export type FieldEncoding =
  | { readonly rows: ReadonlyArray<EncodedField> }
  | { readonly refusal: string };

const describeValue = (value: unknown): string =>
  typeof value === "string"
    ? `the text "${value.slice(0, 40)}"`
    : `${typeof value} ${String(value)}`;

/**
 * Encodes one declared field's value, or returns a sentence naming what was
 * expected. The value is neither null nor undefined.
 */
const encodeValue = (
  field: QualifiedEntityFieldDeclaration,
  value: string | number | boolean,
  kinds: ReadonlyArray<QualifiedEntityKindDeclaration>,
): { readonly text: string } | { readonly number: number } | { readonly expected: string } => {
  switch (field.type) {
    case "text":
    case "person": {
      if (typeof value !== "string") return { expected: "a string" };
      const contextWord = field.facet?.values;
      if (contextWord !== undefined) {
        const prefix = kinds.find((kind) => kind.word === contextWord)?.refPrefix;
        if (prefix !== undefined && !value.startsWith(prefix)) {
          return { expected: `a ref that starts with "${prefix}" (a ${contextWord})` };
        }
      }
      return { text: value };
    }
    case "enum": {
      if (typeof value !== "string") return { expected: "a string" };
      const allowed = field.values.map((entry) => entry.value);
      return allowed.includes(value)
        ? { text: value }
        : { expected: `one of ${allowed.map((entry) => `"${entry}"`).join(", ")}` };
    }
    case "number":
    case "money":
      return typeof value === "number" && Number.isFinite(value)
        ? { number: value }
        : { expected: "a finite number" };
    case "age": {
      const moment = typeof value === "string" ? parseIsoTimestamp(value) : undefined;
      return moment === undefined
        ? {
            expected: "an ISO 8601 timestamp string with a time zone, such as 2026-01-31T09:30:00Z",
          }
        : { number: moment };
    }
    case "bool":
      return typeof value === "boolean" ? { number: value ? 1 : 0 } : { expected: "a boolean" };
  }
};

/**
 * Encodes the declared fields of one full observation into rows, reading
 * each from `observation.fields[key]`. Fields the kind does not declare are
 * not stored. `kinds` are the kinds of the same plugin, to find the ref
 * prefix of a field whose `facet.values` names a context kind.
 *
 * Returns a refusal, naming the ref, the field and what was expected, when a
 * value has the wrong type, is not a declared `enum` value, is not a ref of
 * its context kind, or is not a real timestamp. The caller refuses the whole
 * call with it before anything is written.
 */
export const encodeObservedFields = (input: {
  readonly declaration: QualifiedEntityKindDeclaration;
  readonly kinds: ReadonlyArray<QualifiedEntityKindDeclaration>;
  readonly observation: EntityObservation;
}): FieldEncoding => {
  const { declaration, kinds, observation } = input;
  const reported = observation.partial === true ? {} : observation.fields;
  const rows: Array<EncodedField> = [];
  for (const field of declaration.fields ?? []) {
    const value = reported[field.key];
    if (value === undefined || value === null) continue;
    const encoded = encodeValue(field, value, kinds);
    if ("expected" in encoded) {
      return {
        refusal: `${observation.ref}: the field "${field.key}" of ${declaration.word} is declared as ${field.type}, so it must be ${encoded.expected}, but the observation gave ${describeValue(value)}.`,
      };
    }
    rows.push({
      key: field.key,
      text_value: "text" in encoded ? encoded.text : null,
      number_value: "number" in encoded ? encoded.number : null,
    });
  }
  return { rows };
};

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
 * then key. A constant number of statements however many refs there are. It
 * reads nothing but the field table, so the ingest's comparison on every poll
 * stays cheap. The read of an entity uses `readTitledFieldRows`.
 */
export const readStoredFieldRows = (
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

/**
 * Reads the stored field rows of `refs` in one statement, ordered by ref and
 * then key, each with the title of the record its text value is a ref of.
 * The title is null when no such record exists, and when no Connection reads
 * the record now (some observation of it has `access = 'ok'`, the rule of
 * `deriveAccess`), so a place nobody can read never shows its title.
 */
export const readTitledFieldRows = (
  refs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<TitledFieldRow>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (refs.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<TitledFieldRow>`
      SELECT f.ref, f.key, f.text_value, f.number_value, e.title AS title
      FROM external_entity_fields f
      LEFT JOIN external_entities e
        ON e.ref = f.text_value
        AND EXISTS (SELECT 1 FROM external_entity_observations o
                    WHERE o.ref = e.ref AND o.access = 'ok')
      WHERE f.ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
      ORDER BY f.ref, f.key`;
  });

/**
 * Makes the stored rows of each `FieldSet`'s ref equal its fields, writing
 * only the difference from `stored` (the rows `readStoredFieldRows` returned for
 * these refs before the write). Uses at most two statements however many refs
 * there are. Call it inside the transaction of the write it belongs to.
 * Returns the refs whose rows changed, sorted.
 */
export const writeFieldRows = (
  sets: ReadonlyArray<FieldSet>,
  stored: ReadonlyArray<StoredFieldRow>,
): Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
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
