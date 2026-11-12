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
  type EntityFieldType,
  type InboxClause,
} from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import type { ActiveEntityKind } from "./entity-records";

/** A value bound to a `?` of a compiled expression. */
export type SqlValue = string | number | Uint8Array;

/** A SQL expression and the values its `?` placeholders take, in order. */
export interface CompiledSql {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
}

/** What `compileInboxFilter` returns: the expression, or why the query cannot be answered. */
export type Compilation = CompiledSql | { readonly problem: string };

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
  /** Ties the whole query to one source or one account. */
  readonly tie?: { readonly source?: string; readonly connectionId?: string };
}

/** The core's own query fields, with the type each has. `waiting` is a duration. */
export const CORE_INBOX_FIELDS: ReadonlyArray<{
  readonly key: (typeof CORE_INBOX_FIELD_KEYS)[number];
  readonly label: string;
  readonly type: EntityFieldType;
}> = [
  { key: "source", label: "Source", type: "text" },
  { key: "kind", label: "Kind", type: "text" },
  { key: "account", label: "Account", type: "text" },
  { key: "from", label: "From", type: "person" },
  { key: "waiting", label: "Waiting", type: "age" },
  { key: "asks", label: "Waits on me", type: "bool" },
  { key: "held", label: "With Hercule", type: "bool" },
  { key: "mine", label: "Mine", type: "bool" },
  { key: "signal", label: "Signal", type: "text" },
];

/** The most words of free text one query may hold. */
const MAX_TEXT_WORDS = 12;

/** The plugin id of an entity row `e`: what its kind has before the slash. */
export const SOURCE_OF_KIND_SQL = "substr(e.kind, 1, instr(e.kind, '/') - 1)";

/** Returns the plugin id a qualified kind starts with. */
export const readSourceOfKind = (kind: string): string => kind.slice(0, kind.indexOf("/"));

const NO_MATCH: CompiledSql = { sql: "0", params: [] };

/**
 * Joins expressions with `AND` or `OR`, each in parentheses, and their
 * parameters in order. A part that is always true (`1`) leaves an `AND` out,
 * a part that is always false (`0`) leaves an `OR` out, and the opposite part
 * decides the whole.
 */
const join = (operator: "AND" | "OR", parts: ReadonlyArray<CompiledSql>): CompiledSql => {
  const neutral = operator === "AND" ? "1" : "0";
  const decisive = operator === "AND" ? "0" : "1";
  if (parts.some((part) => part.sql === decisive)) return { sql: decisive, params: [] };
  const kept = parts.filter((part) => part.sql !== neutral);
  if (kept.length === 0) return { sql: neutral, params: [] };
  if (kept.length === 1) return kept[0]!;
  return {
    sql: kept.map((part) => `(${part.sql})`).join(` ${operator} `),
    params: kept.flatMap((part) => part.params),
  };
};

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The condition that the observation row `o` is a Connection observing its
 * thing: it can read it now, or it reports a concern for it. A Connection that
 * only tried and was refused does not observe it.
 */
export const OBSERVING_SQL = `(o.access = 'ok' OR o.concerns <> '[]')`;

/** True when a Connection of this account observes the thing. */
const OBSERVED_BY_SQL = `EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = e.ref AND o.connection_id = ? AND ${OBSERVING_SQL})`;

/**
 * Some Connection reads the record `t` now: the readability rule for a title
 * that belongs to another record, which is restricted data otherwise.
 */
export const READABLE_RECORD_SQL = `EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = t.ref AND o.access = 'ok')`;

/** Escapes the characters `LIKE` treats as patterns, for `ESCAPE '\\'`. */
export const escapeLike = (word: string): string =>
  word.replace(/[\\%_]/g, (match) => `\\${match}`);

/** Reads a clause value as text, or undefined for a boolean. */
const readText = (value: InboxClause["value"]): string | undefined =>
  typeof value === "boolean" ? undefined : String(value);

/** Reads a clause value as a finite number, or undefined. */
const readNumber = (value: InboxClause["value"]): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
};

/** Returns an ISO time `seconds` before `now`, or undefined when that is not a time. */
const readTimeBefore = (now: string, seconds: number): string | undefined => {
  const moment = new Date(Date.parse(now) - seconds * 1000);
  return Number.isNaN(moment.getTime()) ? undefined : moment.toISOString();
};

/** Compiles `is` on a boolean core key: true needs the condition to hold, false that it does not. */
const compileBoolean = (clause: InboxClause, condition: string): CompiledSql | string => {
  if (clause.op !== "is" || typeof clause.value !== "boolean") {
    return `${clause.key} takes "is" with true or false, such as ${clause.key}=true`;
  }
  return { sql: clause.value ? condition : `NOT (${condition})`, params: [] };
};

/** Compiles a clause on a core key, or returns the sentence that says why it cannot be. */
const compileCoreClause = (clause: InboxClause, now: string): CompiledSql | string => {
  const text = readText(clause.value);
  const needsIs = (): string | undefined =>
    clause.op === "is" && text !== undefined
      ? undefined
      : `${clause.key} takes "is" with a word, such as ${clause.key}=value`;
  switch (clause.key) {
    case "source": {
      return needsIs() ?? { sql: `${SOURCE_OF_KIND_SQL} = ? COLLATE NOCASE`, params: [text!] };
    }
    case "kind": {
      return (
        needsIs() ?? {
          sql: `(e.kind = ? OR e.noun = ? COLLATE NOCASE OR substr(e.kind, instr(e.kind, '/') + 1) = ? COLLATE NOCASE)`,
          params: [text!, text!, text!],
        }
      );
    }
    case "account": {
      const problem = needsIs();
      if (problem !== undefined) return problem;
      const byId = UUID_TEXT.test(text!);
      return {
        sql: `EXISTS (SELECT 1 FROM external_entity_observations o JOIN connections c ON c.id = o.connection_id
          WHERE o.ref = e.ref AND (${byId ? "c.id = ? OR " : ""}c.label = ? COLLATE NOCASE))`,
        params: byId ? [uuidFromString(text!), text!] : [text!],
      };
    }
    case "from": {
      const problem = needsIs();
      if (problem !== undefined) return problem;
      return {
        sql: `(EXISTS (SELECT 1 FROM asks a WHERE a.ref = e.ref AND a.asker = ? COLLATE NOCASE)
          OR (e.ask_count IS NULL AND json_extract(e.person, '$.name') = ? COLLATE NOCASE))`,
        params: [text!, text!],
      };
    }
    case "waiting": {
      const seconds = readNumber(clause.value);
      if (clause.op === "is" || seconds === undefined) {
        return `waiting takes "over" or "under" with a duration in seconds, such as waiting>2d`;
      }
      const cutoff = readTimeBefore(now, seconds);
      if (cutoff === undefined) return `waiting ${String(clause.value)} is too long ago`;
      // The wait is the oldest open ask's, so waiting over N seconds means it began before the cutoff.
      return {
        sql:
          clause.op === "over"
            ? `e.oldest_ask IS NOT NULL AND e.oldest_ask < ?`
            : `e.oldest_ask IS NOT NULL AND e.oldest_ask > ?`,
        params: [cutoff],
      };
    }
    case "asks":
      return compileBoolean(clause, "e.ask_count IS NOT NULL");
    case "held":
      return compileBoolean(clause, "e.task_id IS NOT NULL");
    case "mine":
      return compileBoolean(
        clause,
        "EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = e.ref AND o.owned_by_you = 1)",
      );
    case "signal": {
      const problem = needsIs();
      if (problem !== undefined) return problem;
      return {
        sql: `EXISTS (SELECT 1 FROM live_signals s WHERE s.ref = e.ref
          AND (s.kind = ? OR substr(s.kind, instr(s.kind, '/') + 1) = ? COLLATE NOCASE))`,
        params: [text!, text!],
      };
    }
    default:
      return `${clause.key} is not a core field`;
  }
};

/** The condition on one stored field row `f` of the thing `e`, with the key as its first parameter. */
const FIELD_ROW_SQL = (condition: string) =>
  `EXISTS (SELECT 1 FROM external_entity_fields f WHERE f.ref = e.ref AND f.key = ? AND ${condition})`;

/**
 * Compiles a clause on one declared field to its condition, or returns
 * undefined when the clause cannot hold for a field of this type (an operator
 * or a value that does not fit it).
 */
const compileFieldCondition = (
  clause: InboxClause,
  field: DeclaredInboxField,
  now: string,
): CompiledSql | undefined => {
  const key = clause.key;
  switch (field.type) {
    case "text":
    case "person": {
      const text = readText(clause.value);
      if (clause.op !== "is" || text === undefined) return undefined;
      if (field.contextKind === undefined) {
        return {
          sql: FIELD_ROW_SQL("f.text_value IS NOT NULL AND f.text_value = ? COLLATE NOCASE"),
          params: [key, text],
        };
      }
      // A facet of records matches the stored ref (what Browse sends) or the
      // record's title (what a person types). A title is matched only while
      // some Connection can read that record: titles of other records are
      // restricted data.
      return {
        sql: FIELD_ROW_SQL(
          `f.text_value IS NOT NULL AND (f.text_value = ? OR EXISTS (
            SELECT 1 FROM external_entities t
            WHERE t.ref = f.text_value AND t.title = ? COLLATE NOCASE AND ${READABLE_RECORD_SQL}))`,
        ),
        params: [key, text, text],
      };
    }
    case "enum": {
      const text = readText(clause.value)?.toLowerCase();
      if (clause.op !== "is" || text === undefined) return undefined;
      const matching = (field.enumValues ?? [])
        .filter((entry) => entry.value.toLowerCase() === text || entry.label.toLowerCase() === text)
        .map((entry) => entry.value);
      if (matching.length === 0) return undefined;
      return {
        sql: FIELD_ROW_SQL(
          "f.text_value IS NOT NULL AND f.text_value IN (SELECT value FROM json_each(?))",
        ),
        params: [key, JSON.stringify(matching)],
      };
    }
    case "number":
    case "money": {
      const number = readNumber(clause.value);
      if (number === undefined) return undefined;
      const comparison = clause.op === "is" ? "=" : clause.op === "over" ? ">" : "<";
      return {
        sql: FIELD_ROW_SQL(`f.number_value IS NOT NULL AND f.number_value ${comparison} ?`),
        params: [key, number],
      };
    }
    case "age": {
      // The row holds when the age began, in epoch milliseconds. An age over
      // N seconds began before `now - N`.
      const seconds = readNumber(clause.value);
      if (clause.op === "is" || seconds === undefined) return undefined;
      const cutoff = Date.parse(now) - seconds * 1000;
      if (!Number.isFinite(cutoff)) return undefined;
      return {
        sql: FIELD_ROW_SQL(
          `f.number_value IS NOT NULL AND f.number_value ${clause.op === "over" ? "<" : ">"} ?`,
        ),
        params: [key, cutoff],
      };
    }
    case "bool": {
      if (clause.op !== "is" || typeof clause.value !== "boolean") return undefined;
      return {
        sql: FIELD_ROW_SQL("f.number_value IS NOT NULL AND f.number_value = ?"),
        params: [key, clause.value ? 1 : 0],
      };
    }
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
      (clause.source === undefined || readSourceOfKind(field.kind) === clause.source),
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
  for (const { field, kinds } of groups.values()) {
    const condition = compileFieldCondition(clause, field, now);
    if (condition === undefined) continue;
    alternatives.push({
      sql: `e.kind IN (SELECT value FROM json_each(?)) AND ${condition.sql}`,
      params: [JSON.stringify(kinds.sort()), ...condition.params],
    });
  }
  return alternatives.length === 0 ? NO_MATCH : join("OR", alternatives);
};

/** Compiles one clause with the source and account it is tied to. */
const compileClause = (
  clause: InboxClause,
  fields: ReadonlyArray<DeclaredInboxField>,
  now: string,
): CompiledSql | string => {
  const isCore = (CORE_INBOX_FIELD_KEYS as ReadonlyArray<string>).includes(clause.key);
  const body = isCore ? compileCoreClause(clause, now) : compileDeclaredClause(clause, fields, now);
  if (typeof body === "string") return body;
  const ties: Array<CompiledSql> = [];
  if (clause.source !== undefined) {
    ties.push({ sql: `${SOURCE_OF_KIND_SQL} = ?`, params: [clause.source] });
  }
  if (clause.connectionId !== undefined) {
    ties.push({
      sql: OBSERVED_BY_SQL,
      params: [
        UUID_TEXT.test(clause.connectionId)
          ? uuidFromString(clause.connectionId)
          : new Uint8Array(),
      ],
    });
  }
  return join("AND", [...ties, body]);
};

/** Compiles the free text: every word must appear in the title, the identifier or a text field. */
const compileText = (text: string): CompiledSql | string => {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length > MAX_TEXT_WORDS) {
    return `the text has ${String(words.length)} words, and the most is ${String(MAX_TEXT_WORDS)}`;
  }
  return join(
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
  const parts: Array<CompiledSql> = [];
  if (input.tie?.source !== undefined) {
    parts.push({ sql: `${SOURCE_OF_KIND_SQL} = ?`, params: [input.tie.source] });
  }
  if (input.tie?.connectionId !== undefined) {
    parts.push({
      sql: OBSERVED_BY_SQL,
      params: [
        UUID_TEXT.test(input.tie.connectionId)
          ? uuidFromString(input.tie.connectionId)
          : new Uint8Array(),
      ],
    });
  }
  for (const clause of input.clauses) {
    const compiled = compileClause(clause, input.fields, input.now);
    if (typeof compiled === "string") return { problem: compiled };
    parts.push(compiled);
  }
  const text = compileText(input.text);
  if (typeof text === "string") return { problem: text };
  parts.push(text);
  return join("AND", parts);
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
