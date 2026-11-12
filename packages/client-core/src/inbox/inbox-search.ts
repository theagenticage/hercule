/**
 * The Inbox search field: tokens over declared fields (`team:Checkout events:>1000 waiting:>2d`)
 * and free text. Everything here is pure. The caller holds one `InboxSearch`, replaces it with the
 * result of each transition below, and sends `{ clauses, text }` to the read.
 *
 * The list's scope (the saved query or Browse place being searched) is not part of this module:
 * nothing here can remove it.
 */
import type { InboxClause, InboxCounts } from "@hercule/contract";

/** One field of the `InboxCounts.fields` reply: one per (source, key); core fields have no source. */
export type InboxField = InboxCounts["fields"][number];

/** The type of a query field. */
export type InboxFieldType = InboxField["type"];

/** A value the server offers for a field, with how many things hold it. */
export interface SuggestedValue {
  value: string;
  count: number;
}

/** What the transitions need besides the search: the declared fields and the values on offer. */
export interface InboxSearchContext {
  fields: readonly InboxField[];
  /** The server's suggested values, by field key. A key missing here has none. */
  suggestedValues: Readonly<Record<string, readonly SuggestedValue[]>>;
}

/** The state of the search field. Only the transitions below build one. */
export interface InboxSearch {
  /** The tokens, in the order they were added. */
  clauses: readonly InboxClause[];
  /** What the text field holds: free text, then the clause being typed. */
  input: string;
  /** The free text to search. Leaves out a field name that is still being typed. */
  text: string;
  /** The clause being typed at the end of `input`, or null. The caller reads its value suggestions for `key`. */
  open: { key: string; typed: string } | null;
}

/** One row of the suggestion menu. */
export type InboxSuggestion =
  | { kind: "text"; text: string; hint: string }
  | { kind: "field"; key: string; label: string; hint: string }
  | { kind: "value"; key: string; value: string; label: string; count?: number; hint?: string };

/** The suggestion menu: its rows, and the row to highlight at first (-1 for none). */
export interface InboxSuggestionMenu {
  items: InboxSuggestion[];
  highlighted: number;
}

export const EMPTY_INBOX_SEARCH: InboxSearch = { clauses: [], input: "", text: "", open: null };

const SECONDS_PER_UNIT: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 };
const NUMBER_HINTS = [">100", ">1000", ">10000"];
const AGE_HINTS = [">4h", ">1d", ">2d", ">1w"];
const BOOL_VALUES: SuggestedValue[] = [
  { value: "yes", count: 0 },
  { value: "no", count: 0 },
];
const THRESHOLD = { number: /^([<>])(\d+(?:\.\d+)?)$/, age: /^([<>])(\d+)([mhdw])$/ };
const GROUPED = new Intl.NumberFormat("en-US");

/**
 * Returns the search after the text field changed to `input`. A finished `key:value` becomes a
 * clause; free text and the clause still being typed stay in the field. A value runs to the next
 * `key:`, so it can hold spaces. Only the last clause can still be open: a space finishes it unless
 * a suggested value goes on past the space (`project:Checkout ` while "Checkout revamp" is
 * suggested keeps typing), and completes a partial value to the most common suggestion
 * (`team:Check ` becomes `team:Checkout`).
 */
export function typeInboxSearch(
  search: InboxSearch,
  input: string,
  context: InboxSearchContext,
): InboxSearch {
  return absorbInput(search.clauses, input, context, false);
}

/**
 * Returns the search after leaving the field (↩, Tab, Esc, ↓, blur), taking the clause being typed
 * as ↩ would, so the field never shows a filter that does not apply:
 * - the value as typed, when the suggestions hold it or it is a whole threshold;
 * - else the `highlighted` suggestion, when it is a value of that field;
 * - else the value as typed. A value that is not valid for its field (`events:abc`) stays in
 *   the field and is not searched.
 *
 * A half-typed field name is searched as free text from here on.
 */
export function commitInboxSearch(
  search: InboxSearch,
  context: InboxSearchContext,
  highlighted?: InboxSuggestion,
): InboxSearch {
  const open = search.open;
  if (open && highlighted?.kind === "value" && highlighted.key === open.key) {
    const field = findField(context.fields, open.key);
    if (field && !isWholeValue(field, open.typed.trim(), valuesOf(context, open.key))) {
      return takeInboxSuggestion(search, highlighted, context);
    }
  }
  return absorbInput(search.clauses, search.input, context, true);
}

/**
 * Returns the search after taking a suggestion from the menu:
 * - a field replaces the word being typed with `key:`;
 * - a value becomes a clause and the clause being typed leaves the field;
 * - the free-text row changes nothing (the caller then goes to the results).
 */
export function takeInboxSuggestion(
  search: InboxSearch,
  suggestion: InboxSuggestion,
  context: InboxSearchContext,
): InboxSearch {
  if (suggestion.kind === "text") return search;
  if (suggestion.kind === "field") {
    const input = search.input.replace(/\S*$/, `${suggestion.key}:`);
    return absorbInput(search.clauses, input, context, false);
  }
  const field = findField(context.fields, suggestion.key);
  const clause = field && buildClause(field, suggestion.value);
  if (!clause) return search;
  const start = findClauseStarts(search.input, context.fields).at(-1);
  const input = start ? search.input.slice(0, start.at) : search.input;
  return absorbInput([...search.clauses, clause], input, context, false);
}

/** Returns the search with a clause added, as picked from Browse or Narrow: it keeps its source and account. */
export function addInboxClause(search: InboxSearch, clause: InboxClause): InboxSearch {
  return { ...search, clauses: [...search.clauses, clause] };
}

/**
 * Returns the search without the clause at `index`. Out of range changes nothing. ⌫ in an empty
 * field removes the last one: `removeInboxClause(search, search.clauses.length - 1)`.
 */
export function removeInboxClause(search: InboxSearch, index: number): InboxSearch {
  if (index < 0 || index >= search.clauses.length) return search;
  return { ...search, clauses: search.clauses.filter((_, i) => i !== index) };
}

/**
 * Lists what the menu offers for the field's content:
 * - while a clause is open: the values that match what is typed (most common first, at most 8), or
 *   for number and age fields the thresholds, a whole one typed in full first;
 * - else the fields that match the word being typed (at most 6 once something is typed, else 8),
 *   led by a free-text row.
 *
 * With nothing typed no row is highlighted, so ↩ goes to the results and only ↓ reaches the menu.
 */
export function listInboxSuggestions(
  search: InboxSearch,
  context: InboxSearchContext,
): InboxSuggestionMenu {
  const typedAnything = search.input.trim() !== "";
  const highlighted = typedAnything ? 0 : -1;
  const openField = search.open && findField(context.fields, search.open.key);
  if (search.open && openField) {
    return { items: listValueSuggestions(openField, search.open.typed, context), highlighted };
  }

  const word = (search.input.split(/\s+/).pop() ?? "").toLowerCase();
  const seen = new Set<string>();
  const fields: InboxSuggestion[] = [];
  for (const f of context.fields) {
    const key = f.key.toLowerCase();
    if (seen.has(key) || (word && !key.startsWith(word))) continue;
    seen.add(key);
    const example = f.type === "age" ? ", such as >2d" : isNumeric(f.type) ? ", such as >1000" : "";
    fields.push({ kind: "field", key: f.key, label: `${f.key}:`, hint: f.label + example });
  }
  const items = fields.slice(0, typedAnything ? 6 : 8);
  if (typedAnything)
    items.unshift({ kind: "text", text: search.input.trim(), hint: "in titles and fields" });
  return { items, highlighted };
}

/** Returns a clause as the token shows it: `team:Checkout`, `events:>1000`, `waiting:>2d`, `asks:yes`. */
export function describeInboxClause(clause: InboxClause, fields: readonly InboxField[]): string {
  const { key, op, value } = clause;
  if (typeof value === "boolean") return `${key}:${value ? "yes" : "no"}`;
  if (op === "is") return `${key}:${value}`;
  const sign = op === "over" ? ">" : "<";
  if (typeof value === "number" && findField(fields, key)?.type === "age") {
    return `${key}:${sign}${formatDuration(value)}`;
  }
  return `${key}:${sign}${value}`;
}

function findField(fields: readonly InboxField[], key: string): InboxField | undefined {
  const lower = key.toLowerCase();
  return fields.find((f) => f.key.toLowerCase() === lower);
}

function isNumeric(type: InboxFieldType): boolean {
  return type === "number" || type === "money";
}

/** Returns the values on offer for a field: yes and no for a bool field, else the server's. */
function valuesOf(context: InboxSearchContext, key: string): readonly SuggestedValue[] {
  return findField(context.fields, key)?.type === "bool"
    ? BOOL_VALUES
    : (context.suggestedValues[key] ?? []);
}

/** Checks that a typed value needs no completion: a whole threshold, or a value the field holds. */
function isWholeValue(
  field: InboxField,
  typed: string,
  values: readonly SuggestedValue[],
): boolean {
  if (field.type === "age") return THRESHOLD.age.test(typed);
  if (isNumeric(field.type)) return THRESHOLD.number.test(typed);
  const lower = typed.toLowerCase();
  return values.some((v) => v.value.toLowerCase() === lower);
}

/**
 * Returns the clause for a typed value, or undefined when the value is not valid for the field:
 * a threshold on a number or age field, yes or no on a bool field, anything else on the others.
 */
function buildClause(field: InboxField, typed: string): InboxClause | undefined {
  const value = typed.trim();
  if (!value) return undefined;
  const key = field.key;
  if (field.type === "bool") {
    const lower = value.toLowerCase();
    return lower === "yes" || lower === "no"
      ? { key, op: "is", value: lower === "yes" }
      : undefined;
  }
  if (field.type === "age") {
    const m = THRESHOLD.age.exec(value);
    if (!m) return undefined;
    const seconds = Number(m[2]) * SECONDS_PER_UNIT[m[3]!]!;
    return { key, op: m[1] === ">" ? "over" : "under", value: seconds };
  }
  if (isNumeric(field.type)) {
    const m = THRESHOLD.number.exec(value);
    if (!m) return undefined;
    return { key, op: m[1] === ">" ? "over" : "under", value: Number(m[2]) };
  }
  return { key, op: "is", value };
}

/**
 * Returns the value a trailing space finishes, or undefined when the space belongs to the value.
 * - A suggested value goes on past the space (`Checkout` while `Checkout revamp` exists): undefined,
 *   so a value with spaces can be typed out.
 * - The value as typed is one that is offered, or nothing offered starts with it (a threshold, a
 *   new word): it is taken as typed.
 * - Offered values start with it (`Check`): the most common of them completes it.
 */
function finishTypedValue(raw: string, values: readonly SuggestedValue[]): string | undefined {
  if (!/\s$/.test(raw) || !raw.trim()) return undefined;
  const typed = raw.trim();
  const lower = typed.toLowerCase();
  const held = [...values].sort((a, b) => b.count - a.count).map((v) => v.value);
  if (held.some((v) => v.toLowerCase().startsWith(`${lower} `))) return undefined;
  if (held.some((v) => v.toLowerCase() === lower)) return typed;
  return held.find((v) => v.toLowerCase().startsWith(lower)) ?? typed;
}

interface ClauseStart {
  /** Where the `key:` begins. */
  at: number;
  /** Where its value begins. */
  from: number;
  field: InboxField;
}

/** Finds each `key:` of a known field in the text, in order. */
function findClauseStarts(input: string, fields: readonly InboxField[]): ClauseStart[] {
  const starts: ClauseStart[] = [];
  for (const m of input.matchAll(/(^|\s)([a-z][\w-]*):/gi)) {
    const field = findField(fields, m[2]!);
    if (field) starts.push({ at: m.index + m[1]!.length, from: m.index + m[0].length, field });
  }
  return starts;
}

/**
 * Turns every finished clause in `input` into a token and keeps the rest in the field. With `final`,
 * the last clause is taken as typed too. A clause that is not valid for its field is dropped,
 * except the last one, which stays in the field.
 */
function absorbInput(
  clauses: readonly InboxClause[],
  input: string,
  context: InboxSearchContext,
  final: boolean,
): InboxSearch {
  const starts = findClauseStarts(input, context.fields);
  const free = starts.length ? input.slice(0, starts[0]!.at) : input;
  const taken = [...clauses];
  let openText = "";
  starts.forEach((start, i) => {
    const raw = input.slice(start.from, starts[i + 1]?.at ?? input.length);
    const last = i === starts.length - 1;
    const value =
      last && !final ? finishTypedValue(raw, valuesOf(context, start.field.key)) : raw.trim();
    const clause = value ? buildClause(start.field, value) : undefined;
    if (clause) taken.push(clause);
    else if (last) openText = input.slice(start.at);
  });

  const words = free.trim() ? free.trim().split(/\s+/) : [];
  // The last word may be a field name being typed: it is not searched until it clearly is not one.
  const tail = words.at(-1)?.toLowerCase();
  const isNamePrefix =
    tail !== undefined &&
    tail.length >= 2 &&
    context.fields.some((f) => f.key.toLowerCase().startsWith(tail));
  if (!final && !openText && !/\s$/.test(free) && isNamePrefix) words.pop();

  const openStart = openText ? findClauseStarts(openText, context.fields)[0] : undefined;
  const open = openStart
    ? { key: openStart.field.key, typed: openText.slice(openStart.from) }
    : null;
  return { clauses: taken, input: free + openText, text: words.join(" "), open };
}

function listValueSuggestions(
  field: InboxField,
  rawTyped: string,
  context: InboxSearchContext,
): InboxSuggestion[] {
  const typed = rawTyped.trimStart().toLowerCase();
  const suggest = (
    value: string,
    extra: { count?: number; hint?: string } = {},
  ): InboxSuggestion => ({
    kind: "value",
    key: field.key,
    value,
    label: `${field.key}:${value}`,
    ...extra,
  });

  if (isNumeric(field.type) || field.type === "age") {
    const age = field.type === "age";
    const whole = (age ? THRESHOLD.age : THRESHOLD.number).test(typed);
    const hints = (age ? AGE_HINTS : NUMBER_HINTS).filter(
      (h) => h !== typed && h.startsWith(typed),
    );
    // A threshold typed in full comes first, as typed, so ↩ never swaps it for a longer one.
    return [...(whole ? [typed] : []), ...hints].map((h) =>
      suggest(h, { hint: describeThreshold(field, h) }),
    );
  }

  return [...valuesOf(context, field.key)]
    .filter((v) => v.value.toLowerCase().includes(typed))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((v) => suggest(v.value, field.type === "bool" ? {} : { count: v.count }));
}

/** Returns the words for a threshold: "waiting longer than 2d", "more than 1,000". */
function describeThreshold(field: InboxField, threshold: string): string {
  const over = threshold.startsWith(">");
  const amount = threshold.slice(1);
  if (field.type === "age") {
    return `${field.label.toLowerCase()} ${over ? "longer" : "shorter"} than ${amount}`;
  }
  return `${over ? "more" : "less"} than ${GROUPED.format(Number(amount))}`;
}

/** Returns seconds as the largest whole unit: 172800 is `2d`, 5400 is `90m`. */
function formatDuration(seconds: number): string {
  for (const unit of ["w", "d", "h", "m"] as const) {
    const size = SECONDS_PER_UNIT[unit]!;
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}
