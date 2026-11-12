/**
 * Compiles the conditions of an Inbox query into SQL.
 *
 * One pure function, `compileInboxFilter`, turns clauses and free text into a
 * boolean SQL expression with bound parameters. The page, the facet counts,
 * the saved query counts and the value suggestions all filter with it, so a
 * clause means the same everywhere. It reads no database and runs no Effect.
 *
 * The expression reads one row of `eligible` as the alias `e`, and the helper
 * tables of `buildEligibleEntities` (`asks`, `live_signals`). Every identifier
 * and operator in the text comes from this file. A value from a caller is
 * always a bound parameter, in the order its `?` appears in the text.
 *
 * Text matching is case-insensitive for ASCII letters only: SQLite's `NOCASE`
 * and `LIKE` do not fold other alphabets.
 */
import {
  CORE_INBOX_FIELD_KEYS,
  interpretClauseValue,
  type ClauseInterpretation,
  type EntityFieldType,
  type InboxClause,
} from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import type { ActiveEntityKind } from "./entity-records";
import {
  buildSourceOfKindSql,
  CORE_KEYS,
  isCoreKey,
  joinConditions,
  OBSERVING_SQL,
  parseSourceOfKind,
  READABLE_RECORD_SQL,
  readCoreKeyType,
  UUID_TEXT,
  type CompiledSql,
  type CoreKeyContext,
} from "./inbox-relation";

/**
 * What `compileInboxFilter` returns: the expression, or why the query cannot
 * be answered and which part of the query holds the mistake.
 */
export type Compilation =
  | CompiledSql
  | { readonly problem: string; readonly part: "clauses" | "text" };

/** One field a plugin declared for one entity kind, as a query reads it. */
export interface DeclaredInboxField {
  /** The qualified entity kind that declares the field. */
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly type: EntityFieldType;
  /** For a facet: the plural name of its values, such as "Teams". */
  readonly plural?: string;
  /** For a facet whose values are records of a context kind: that qualified kind. */
  readonly contextKind?: string;
  /** The values of an `enum` field, with their labels. */
  readonly enumValues?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** The currency of a `money` field. */
  readonly currency?: string;
  /** True when the field is a facet: Browse and Narrow list its values. */
  readonly isFacet: boolean;
}

/** The input of `compileInboxFilter`. */
export interface InboxFilterInput {
  /** All of these must hold. */
  readonly clauses: ReadonlyArray<InboxClause>;
  /** Words that must all appear in the title, the identifier or a text field. May be empty. */
  readonly text: string;
  /** The one read clock: durations are measured back from it. A normalized UTC ISO string. */
  readonly now: string;
  readonly fields: ReadonlyArray<DeclaredInboxField>;
  /** The signal kinds of the active plugins: a `signal` clause matches a kind's noun. */
  readonly signalKinds: ReadonlyArray<{ readonly kind: string; readonly noun: string }>;
  /** Ties the whole query to one source or one account. */
  readonly tie?: { readonly source?: string; readonly connectionId?: string };
}

/** The most words of free text one query may hold. */
const MAX_TEXT_WORDS = 12;

const NO_MATCH: CompiledSql = { sql: "0", params: [] };

/** True when a Connection of this account observes the thing. */
const OBSERVED_BY_SQL = `EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = e.ref AND o.connection_id = ? AND ${OBSERVING_SQL})`;

/** Escapes the characters `LIKE` treats as patterns, for `ESCAPE '\\'`. */
export const escapeLike = (word: string): string =>
  word.replace(/[\\%_]/g, (match) => `\\${match}`);

/** The condition on one stored field row `f` of the thing `e`, with the key as its first parameter. */
const buildFieldRowSql = (condition: string): string =>
  `EXISTS (SELECT 1 FROM external_entity_fields f WHERE f.ref = e.ref AND f.key = ? AND ${condition})`;

/** Compiles a clause on a core key, or returns the sentence that says why it cannot be. */
const compileCoreClause = (clause: InboxClause, context: CoreKeyContext): CompiledSql | string => {
  const reading = interpretClauseValue(
    clause.key,
    readCoreKeyType(clause.key)!,
    clause.op,
    clause.value,
  );
  return reading.ok
    ? CORE_KEYS[clause.key as keyof typeof CORE_KEYS].filter(reading.value, clause.op, context)
    : reading.reason;
};

/** Why a clause cannot hold for one declared field: its operator is wrong, or its value does not fit. */
interface FieldRefusal {
  readonly refusal: Extract<ClauseInterpretation, { ok: false }>;
}

/**
 * Compiles a clause on one declared field to its condition. Returns a refusal
 * when the clause cannot hold for a field of this type: the operator is not
 * one the type takes, or the value does not fit the type. Returns undefined
 * when the clause is well formed but nothing can match, such as an enum value
 * the field does not declare.
 */
const compileFieldCondition = (
  clause: InboxClause,
  field: DeclaredInboxField,
  now: string,
): CompiledSql | FieldRefusal | undefined => {
  const key = clause.key;
  const reading = interpretClauseValue(key, field.type, clause.op, clause.value);
  if (!reading.ok) return { refusal: reading };
  const value = reading.value;
  switch (field.type) {
    case "text":
    case "person": {
      const text = String(value);
      if (field.contextKind === undefined) {
        return {
          sql: buildFieldRowSql("f.text_value IS NOT NULL AND f.text_value = ? COLLATE NOCASE"),
          params: [key, text],
        };
      }
      // A facet of records matches the stored ref (what Browse sends) or the
      // record's title (what a person types). A title is matched only while
      // some Connection can read that record: titles of other records are
      // restricted data.
      return {
        sql: buildFieldRowSql(
          `f.text_value IS NOT NULL AND (f.text_value = ? OR EXISTS (
            SELECT 1 FROM external_entities t
            WHERE t.ref = f.text_value AND t.title = ? COLLATE NOCASE AND ${READABLE_RECORD_SQL}))`,
        ),
        params: [key, text, text],
      };
    }
    case "enum": {
      const text = String(value).toLowerCase();
      const matching = (field.enumValues ?? [])
        .filter((entry) => entry.value.toLowerCase() === text || entry.label.toLowerCase() === text)
        .map((entry) => entry.value);
      if (matching.length === 0) return undefined;
      return {
        sql: buildFieldRowSql(
          "f.text_value IS NOT NULL AND f.text_value IN (SELECT value FROM json_each(?))",
        ),
        params: [key, JSON.stringify(matching)],
      };
    }
    case "number":
    case "money": {
      const comparison = clause.op === "is" ? "=" : clause.op === "over" ? ">" : "<";
      return {
        sql: buildFieldRowSql(`f.number_value IS NOT NULL AND f.number_value ${comparison} ?`),
        params: [key, Number(value)],
      };
    }
    case "age": {
      // The row holds when the age began, in epoch milliseconds. An age over
      // N seconds began before `now - N`.
      const cutoff = Date.parse(now) - Number(value) * 1000;
      if (!Number.isFinite(cutoff)) return undefined;
      return {
        sql: buildFieldRowSql(
          `f.number_value IS NOT NULL AND f.number_value ${clause.op === "over" ? "<" : ">"} ?`,
        ),
        params: [key, cutoff],
      };
    }
    case "bool":
      return {
        sql: buildFieldRowSql("f.number_value IS NOT NULL AND f.number_value = ?"),
        params: [key, value === true ? 1 : 0],
      };
  }
};

/**
 * Compiles a clause on a declared field. Each distinct way the matching kinds
 * declare the key (type, context kind, enum values) compiles on its own and is
 * limited to the kinds that declare it that way, and the results are joined
 * with `OR`. A kind whose declaration cannot hold the clause never matches.
 */
const compileDeclaredClause = (
  clause: InboxClause,
  fields: ReadonlyArray<DeclaredInboxField>,
  now: string,
): CompiledSql | string => {
  const declared = fields.filter(
    (field) =>
      field.key === clause.key &&
      (clause.source === undefined || parseSourceOfKind(field.kind) === clause.source),
  );
  if (declared.length === 0) {
    const known = [
      ...new Set([...CORE_INBOX_FIELD_KEYS, ...fields.map((field) => field.key)]),
    ].sort();
    return `no source declares a field "${clause.key}"${clause.source === undefined ? "" : ` for ${clause.source}`}. The fields are: ${known.join(", ")}.`;
  }
  const groups = new Map<string, { field: DeclaredInboxField; kinds: Array<string> }>();
  for (const field of declared) {
    const signature = JSON.stringify([
      field.type,
      field.contextKind ?? null,
      field.enumValues ?? null,
    ]);
    const group = groups.get(signature) ?? { field, kinds: [] };
    group.kinds.push(field.kind);
    groups.set(signature, group);
  }
  const alternatives: Array<CompiledSql> = [];
  const refusals: Array<FieldRefusal["refusal"]> = [];
  for (const { field, kinds } of groups.values()) {
    const condition = compileFieldCondition(clause, field, now);
    if (condition === undefined) continue;
    if ("refusal" in condition) {
      refusals.push(condition.refusal);
      continue;
    }
    alternatives.push({
      // The unary plus keeps SQLite from walking the kind index for this
      // condition: the field rows are the selective part, and the kind index
      // serves the known values of a facet instead.
      sql: `+e.kind IN (SELECT value FROM json_each(?)) AND ${condition.sql}`,
      params: [JSON.stringify(kinds.sort()), ...condition.params],
    });
  }
  // A value that does not fit the type of one source does not match there. An
  // operator that no declaration of the key takes is a mistake, and refused.
  const wrongOperator = refusals.find((refusal) => refusal.cause === "operator");
  if (alternatives.length === 0 && wrongOperator !== undefined) return wrongOperator.reason;
  return alternatives.length === 0 ? NO_MATCH : joinConditions("OR", alternatives);
};

/**
 * Compiles the conditions that tie a query or a clause to one source and one
 * account: the thing is of that source, and a Connection of that account
 * observes it. Returns no condition for a tie that names neither.
 */
const compileTie = (tie: {
  readonly source?: string | undefined;
  readonly connectionId?: string | undefined;
}): ReadonlyArray<CompiledSql> => {
  const conditions: Array<CompiledSql> = [];
  if (tie.source !== undefined) {
    conditions.push({ sql: `${buildSourceOfKindSql("e")} = ?`, params: [tie.source] });
  }
  if (tie.connectionId !== undefined) {
    // An id that is not a UUID matches no Connection.
    conditions.push({
      sql: OBSERVED_BY_SQL,
      params: [
        UUID_TEXT.test(tie.connectionId) ? uuidFromString(tie.connectionId) : new Uint8Array(),
      ],
    });
  }
  return conditions;
};

/** Compiles one clause with the source and account it is tied to. */
const compileClause = (clause: InboxClause, input: InboxFilterInput): CompiledSql | string => {
  const body = isCoreKey(clause.key)
    ? compileCoreClause(clause, { now: input.now, signalKinds: input.signalKinds })
    : compileDeclaredClause(clause, input.fields, input.now);
  if (typeof body === "string") return body;
  return joinConditions("AND", [...compileTie(clause), body]);
};

/** Compiles the free text: every word must appear in the title, the identifier or a text field. */
const compileText = (text: string): CompiledSql | string => {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length > MAX_TEXT_WORDS) {
    return `the text has ${String(words.length)} words, and the most is ${String(MAX_TEXT_WORDS)}`;
  }
  return joinConditions(
    "AND",
    words.map((word): CompiledSql => {
      const pattern = `%${escapeLike(word)}%`;
      return {
        sql: `e.title LIKE ? ESCAPE '\\' OR e.identifier LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM external_entity_fields f
          WHERE f.ref = e.ref AND f.text_value IS NOT NULL AND (f.text_value LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM external_entities t
              WHERE t.ref = f.text_value AND t.title LIKE ? ESCAPE '\\' AND ${READABLE_RECORD_SQL})))`,
        params: [pattern, pattern, pattern, pattern],
      };
    }),
  );
};

/**
 * Compiles the clauses and the free text of an Inbox query into one boolean
 * SQL expression over the alias `e`, or returns `problem`: a sentence naming
 * the clause that cannot be answered and what to write instead. A clause that
 * is well formed but cannot match anything, such as `over` on a text field,
 * compiles to an expression that is false for every thing.
 */
export const compileInboxFilter = (input: InboxFilterInput): Compilation => {
  const parts: Array<CompiledSql> = [...compileTie(input.tie ?? {})];
  for (const clause of input.clauses) {
    const compiled = compileClause(clause, input);
    if (typeof compiled === "string") return { problem: compiled, part: "clauses" };
    parts.push(compiled);
  }
  const text = compileText(input.text);
  if (typeof text === "string") return { problem: text, part: "text" };
  parts.push(text);
  return joinConditions("AND", parts);
};

/**
 * Lists the declared fields of the active entity kinds as the query reads
 * them: one per kind and key, in declaration order.
 */
export const listDeclaredInboxFields = (
  kinds: ReadonlyArray<ActiveEntityKind>,
): ReadonlyArray<DeclaredInboxField> =>
  kinds.flatMap((kind) =>
    (kind.fields ?? []).map((field): DeclaredInboxField => ({
      kind: kind.kind,
      key: field.key,
      label: field.label,
      type: field.type,
      isFacet: field.facet !== undefined,
      ...(field.facet === undefined ? {} : { plural: field.facet.plural }),
      ...(field.facet?.values === undefined ? {} : { contextKind: field.facet.values }),
      ...(field.type === "enum"
        ? {
            enumValues: field.values.map((entry) => ({
              value: entry.value,
              label: entry.label ?? entry.value,
            })),
          }
        : {}),
      ...(field.type === "money" ? { currency: field.currency } : {}),
    })),
  );
