/**
 * Human output.
 *
 * `--json` prints the contract's output schema verbatim and this module is not
 * reached. Everything here is for a person: a page becomes a table, a single
 * object becomes aligned key-value lines, and ids are shortened to the tail the
 * CLI accepts back as an argument.
 */
import type { Outcome } from "./execute";
import type { Command } from "./tree";

/** A canonical lowercase UUIDv7; the only value shortened to a tail. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** How long a tail the human rendering prints, and the shortest the CLI accepts. */
const TAIL = 8;

const cell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return CANONICAL_ID.test(value) ? value.slice(-TAIL) : value;
  if (Array.isArray(value)) return value.map(cell).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
};

/** Every key any row has, in the order the rows introduce them. */
const columnsOf = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const columns: Array<string> = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return columns;
};

const table = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  if (rows.length === 0) return ["no results"];
  const columns = columnsOf(rows);
  const body = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...body.map((row) => row[index]!.length)),
  );
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((text, index) => (index === cells.length - 1 ? text : text.padEnd(widths[index]!)))
      .join("  ")
      .trimEnd();
  return [line(columns), ...body.map(line)];
};

/**
 * A nested object becomes dotted keys rather than a JSON blob, so
 * `hydra settings read` reads as the flat key set it is. An array stays a cell:
 * its elements are values, not sub-keys.
 */
const flatten = (
  value: Record<string, unknown>,
  prefix = "",
): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(value).flatMap(([key, item]) => {
    const name = `${prefix}${key}`;
    return typeof item === "object" && item !== null && !Array.isArray(item)
      ? flatten(item as Record<string, unknown>, `${name}.`)
      : [[name, item] as const];
  });

const keyValues = (value: Record<string, unknown>): ReadonlyArray<string> => {
  const entries = flatten(value);
  if (entries.length === 0) return ["ok"];
  const width = Math.max(...entries.map(([key]) => key.length));
  // Trimmed as the table's lines are: a key whose value is empty reads as the
  // key, not as the key plus the padding that would have held a value.
  return entries.map(([key, item]) => `${key.padEnd(width)}  ${cell(item)}`.trimEnd());
};

const isPage = (
  value: unknown,
): value is { items: Array<Record<string, unknown>>; nextCursor?: string } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { items?: unknown }).items);

/**
 * The fields of a normalized event that say nothing on a transcript line: the
 * event's own id, the session every line belongs to, the instant the line
 * already begins with, and the turn and item ids, which name nothing a reader
 * can look up. What is left is the tag's own payload, which is the part that
 * differs from line to line.
 */
const TRANSCRIPT_NOISE = new Set([
  "_tag",
  "eventId",
  "sessionId",
  "at",
  "providerRefs",
  "raw",
  "turnId",
  "itemId",
]);

/** How much of one field's value a transcript line shows before it is cut. */
const TRANSCRIPT_FIELD = 100;

/**
 * One value on a transcript line: on one line, and short. A coalesced
 * `content.delta` carries a whole assistant message or a screenful of command
 * output, and a transcript is read for its shape - `hydra transcript read
 * --json` is what hands back the text in full.
 */
const brief = (value: unknown): string => {
  const text = cell(value).replace(/\s+/g, " ").trim();
  return text.length > TRANSCRIPT_FIELD ? `${text.slice(0, TRANSCRIPT_FIELD)}...` : text;
};

/** `<position>  <at>  <tag>  <what that tag adds>`. */
const transcriptLine = (row: Record<string, unknown>): string => {
  const event = (row["event"] ?? {}) as Record<string, unknown>;
  const said = Object.entries(event)
    .filter(([key]) => !TRANSCRIPT_NOISE.has(key))
    .map(([key, value]) => `${key}=${brief(value)}`);
  return [cell(row["position"]), cell(row["at"]), cell(event["_tag"]), ...said]
    .join("  ")
    .trimEnd();
};

/**
 * A transcript is a sequence, not a set of records: every row is the same three
 * columns plus a payload whose fields differ per tag, so a table of it would be
 * mostly empty cells. It is rendered as lines instead.
 */
const transcript = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  rows.length === 0 ? ["no results"] : rows.map(transcriptLine);

/** The lines the CLI prints for a successful command, without `--json`. */
export const renderHuman = (outcome: Outcome, command: Command): ReadonlyArray<string> => {
  const asLines = command.id === "transcript.read" ? transcript : table;

  if (outcome.kind === "items") return asLines(outcome.items);

  const value = outcome.value;
  if (isPage(value)) {
    const lines = [...asLines(value.items)];
    if (value.nextCursor !== undefined) {
      lines.push("", `more results: --cursor ${value.nextCursor}, or --all`);
    }
    return lines;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const lines = [...keyValues(record)];
    // The one teaching line this build has. Spec 11 section 10 teaches
    // `subscribe` after a spawn; there is no subscription domain yet, so what a
    // caller is pointed at is the transcript it can already read. This becomes
    // the subscribe line the spec names when subscriptions land.
    if (command.id === "session.spawn") {
      lines.push("", `read what it says with \`hydra transcript read ${cell(record["id"])}\``);
    }
    return lines;
  }
  return [cell(value)];
};
