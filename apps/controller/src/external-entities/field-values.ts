/**
 * What the fields of an External Entity mean: how an observation's declared
 * fields become stored rows, how a stored row becomes a field value, and the
 * card face drawn from those values.
 *
 * A kind declares its fields (`EntityKindDeclaration.fields`). A full
 * observation reports a value for each in `fields[key]`. A field with a value
 * is one row, with its value in exactly one column:
 *
 * - `text`, `person` and `enum` are stored in `text_value`.
 * - `number` and `money` are stored in `number_value`.
 * - `age` is stored in `number_value` as epoch milliseconds.
 * - `bool` is stored in `number_value` as 0 or 1.
 *
 * A field that is null or missing has no row. Nothing here reads the
 * database: `entity-fields.ts` stores and reads the rows, and this module
 * decides what they mean.
 */
import type { CardFace, EntityFieldValue } from "@hercule/contract";
import {
  CARD_FACE_SLOTS,
  ISO_TIMESTAMP_PATTERN,
  type QualifiedEntityFieldDeclaration,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import type { ActiveEntityKind } from "./entity-records";
import type { FullEntityObservation } from "./slots";

/** One field value of an observation, encoded for storage. Exactly one value column is not null. */
export interface EncodedField {
  readonly key: string;
  readonly text_value: string | null;
  readonly number_value: number | null;
}

/**
 * One stored field value with the title of the record it points at. `title`
 * is not null only when `text_value` is the ref of a record that some
 * Connection reads now (the same rule as `buildPlace`, which shows no title
 * for a restricted place).
 */
export interface TitledField extends EncodedField {
  readonly title: string | null;
}

/** What `encodeObservedFields` returns: the rows to store, or why the observation is refused. */
export type FieldEncoding =
  | { readonly rows: ReadonlyArray<EncodedField> }
  | { readonly refusal: string };

/** The first and last instants whose year has four digits (0000 to 9999), which the contract's timestamp can write. */
const FIRST_AGE_MS = Date.parse("0000-01-01T00:00:00.000Z");
const LAST_AGE_MS = Date.parse("9999-12-31T23:59:59.999Z");

/** Checks that an age is an instant the contract can write as a timestamp (year 0000 to 9999). */
const isRepresentableAge = (epochMs: number): boolean =>
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
 * prefix of a field whose `facet.values` names a context kind. A partial
 * observation has no fields to store, so callers do not pass one.
 *
 * Returns a refusal, naming the ref, the field and what was expected, when a
 * value has the wrong type, is not a declared `enum` value, is not a ref of
 * its context kind, or is not a real timestamp. The caller refuses the whole
 * call with it before anything is written.
 */
export const encodeObservedFields = (input: {
  readonly declaration: QualifiedEntityKindDeclaration;
  readonly kinds: ReadonlyArray<QualifiedEntityKindDeclaration>;
  readonly observation: FullEntityObservation;
}): FieldEncoding => {
  const { declaration, kinds, observation } = input;
  const rows: Array<EncodedField> = [];
  for (const field of declaration.fields ?? []) {
    const value = observation.fields[field.key];
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

/** Checks that a field holds a ref: its facet lists the records of a context kind. */
const holdsRef = (declaration: QualifiedEntityFieldDeclaration): boolean =>
  declaration.type === "text" && declaration.facet?.values !== undefined;

/**
 * Decodes the value of one declared field from its stored row. Returns
 * undefined when there is no row, when the row's encoding does not fit the
 * field's current declaration (a stale row that the next observation
 * rewrites), when an enum value is no longer declared, when a ref has no
 * readable record (its title is null), or when an age is outside the years
 * 0000 to 9999. It never fails and never reinterprets a row.
 */
const decodeFieldValue = (
  declaration: QualifiedEntityFieldDeclaration,
  row: TitledField | undefined,
): EntityFieldValue | undefined => {
  if (row === undefined) return undefined;
  const identity = { key: declaration.key, label: declaration.label };
  const { text_value: text, number_value: number } = row;
  switch (declaration.type) {
    case "text":
    case "person":
    case "enum": {
      if (text === null || number !== null) return undefined;
      if (declaration.type === "enum") {
        const declared = declaration.values.find((entry) => entry.value === text);
        if (declared === undefined) return undefined;
        return { ...identity, type: "enum", value: text, text: declared.label ?? text };
      }
      if (declaration.type === "text" && holdsRef(declaration)) {
        const title = row.title;
        if (title === null) return undefined;
        return { ...identity, type: "text", text: title, ref: text };
      }
      return { ...identity, type: declaration.type, text };
    }
    case "number":
    case "money":
    case "age":
    case "bool": {
      if (number === null || text !== null || !Number.isFinite(number)) return undefined;
      switch (declaration.type) {
        case "number":
          return { ...identity, type: "number", number };
        case "money":
          return { ...identity, type: "money", amount: number, currency: declaration.currency };
        case "age": {
          return isRepresentableAge(number)
            ? { ...identity, type: "age", since: new Date(number).toISOString() }
            : undefined;
        }
        case "bool":
          return number === 0 || number === 1
            ? { ...identity, type: "bool", value: number === 1 }
            : undefined;
      }
    }
  }
};

/**
 * Decodes the field values of one thing and draws its card face from the
 * stored rows of its fields. Returns both as `{ fields, face }`. A ref-valued
 * field takes its text from the title its row carries.
 *
 * - Only declared keys come back, in declaration order. A row of an
 *   undeclared key is ignored.
 * - A kind that is not active (`kind` is undefined: its plugin is stopped, or
 *   the kind is gone) gives no fields and no face, so the client draws the
 *   generic card.
 * - A kind that declares no face gives a null face.
 * - A slot of the face whose field has no value is left out.
 */
export const decodeEntityFields = (
  kind: ActiveEntityKind | undefined,
  rows: ReadonlyArray<TitledField>,
): { readonly fields: EntityFieldValue[]; readonly face: CardFace | null } => {
  if (kind === undefined) return { fields: [], face: null };
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const fields = (kind.fields ?? []).flatMap((declaration) => {
    const value = decodeFieldValue(declaration, byKey.get(declaration.key));
    return value === undefined ? [] : [value];
  });
  if (kind.face === undefined) return { fields, face: null };
  const face: { -readonly [Slot in keyof CardFace]: CardFace[Slot] } = {};
  for (const slot of CARD_FACE_SLOTS) {
    const key = kind.face[slot];
    const value = key === undefined ? undefined : fields.find((field) => field.key === key);
    if (value !== undefined) face[slot] = value;
  }
  return { fields, face };
};
