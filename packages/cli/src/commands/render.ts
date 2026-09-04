/**
 * Human output (spec 11 section 6.3).
 *
 * `--json` prints the contract's output schema verbatim and this module is not
 * reached. Everything here is for a person: a page becomes a table, a single
 * object becomes aligned key-value lines, and ids are shortened to the tail the
 * CLI accepts back as an argument.
 */
import type { Outcome } from "./execute";

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
  return entries.map(([key, item]) => `${key.padEnd(width)}  ${cell(item)}`);
};

const isPage = (
  value: unknown,
): value is { items: Array<Record<string, unknown>>; nextCursor?: string } =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { items?: unknown }).items);

/** The lines the CLI prints for a successful command, without `--json`. */
export const renderHuman = (outcome: Outcome): ReadonlyArray<string> => {
  if (outcome.kind === "items") return table(outcome.items);

  const value = outcome.value;
  if (isPage(value)) {
    const lines = [...table(value.items)];
    if (value.nextCursor !== undefined) {
      lines.push("", `more results: --cursor ${value.nextCursor}, or --all`);
    }
    return lines;
  }
  if (typeof value === "object" && value !== null)
    return keyValues(value as Record<string, unknown>);
  return [cell(value)];
};
