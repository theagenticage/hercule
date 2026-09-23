/**
 * Keyset paging, shared by every list operation.
 *
 * A cursor holds the sort key of the page's last row plus that row's id, and is
 * opaque to the client. The pair is unique because the id alone is unique, so a
 * page boundary never repeats or skips a row. That is why the API needs no page
 * numbers and no totals.
 *
 * This guarantee holds only while the sort key does not change. A row whose key
 * is updated between two pages moves to wherever the new key puts it, ahead of
 * the cursor or behind it. A client that must see every row exactly once should
 * sort by a key that never changes. A cursor is base64url-encoded JSON, so a
 * sort key can contain any character and still decode to exactly one value.
 *
 * A cursor also holds the operation that issued it and the sort order it used:
 * `[op, field, direction, key, id]`. Without them a cursor would be just two
 * strings, and one operation's cursor would decode cleanly in another. For
 * example, a secrets cursor holding a name would be compared against
 * `created_at` and quietly return a page with a meaningless boundary. With the
 * operation and sort order in the cursor, every such mismatch, including the
 * same operation with a different sort, fails with one `validation` error.
 *
 * There are four kinds of cursor, one per kind of list:
 *
 * - keyset over a sort key plus a UUID;
 * - keyset over a sort key plus the UUID of the record that owns the row and
 *   the row's name inside that record. A trigger has no id of its own, so it
 *   is identified this way;
 * - keyset over an integer id alone, which is what the event log sorts by;
 * - an offset, which relevance-ordered full-text results need because a bm25
 *   rank is not a stable key to resume from.
 *
 * The integer-id and offset cursors both hold a bare number, so each one also
 * stores its kind inside the cursor. An offset can then never be read back as
 * an id. The operation and sort order alone would not always tell the two
 * apart.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  MAX_PAGE_LIMIT,
  SortDirection,
  createValidationError,
  type OperationId,
  type Validation,
} from "@hercule/contract";
import { UUID_PATTERN } from "./id";

/** One page of a keyset list. `nextCursor` is `undefined` on the last page. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
}

/** The paging input of a list operation: how many rows, where to start, and which direction. */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: "asc" | "desc";
}

/**
 * The query a cursor belongs to: the operation, the field it sorts on and the
 * sort direction. A cursor is only valid for exactly the same query.
 *
 * A query that is not sorted by a column, such as a search sorted by relevance,
 * has no field name to put here. It must put whatever its order depends on,
 * such as the search text, in `field` instead. Otherwise page two of one search
 * would resume inside the results of another, which is the mistake this scope
 * exists to prevent.
 */
export interface CursorScope {
  readonly op: OperationId;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** A cursor that was not issued by this operation, or was edited by the client. */
export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String,
}) {}

const NOT_OURS = "The cursor is not one this listing issued.";
const OTHER_ORDER = "The cursor was issued under a different sort order.";

/**
 * The error message for a cursor whose `field` does not match. It differs from
 * the message for a wrong direction because `field` is not always a column
 * name. It can also hold the session a transcript position belongs to, or the
 * text a relevance search looked for. "A different sort order" would then send
 * the caller to check `--sort` when it is the list itself that changed.
 */
const OTHER_LISTING = "The cursor was issued for a different listing.";

/** The values a cursor holds after the operation, field and direction. */
type Payload = ReadonlyArray<string | number>;

/** A sort key in a cursor: the value of the sort column. */
export type SortKey = string | number;

const sealCursor = (scope: CursorScope, payload: Payload): string =>
  Buffer.from(
    JSON.stringify([scope.op, scope.field, scope.direction, ...payload]),
    "utf8",
  ).toString("base64url");

/**
 * Decodes a cursor and returns its payload, parsed by `shape`. Fails with
 * `CursorError` when the cursor does not decode, belongs to another scope, or
 * `shape` returns `undefined`.
 *
 * `shape` is what stops a cursor of one kind from being read as another kind:
 * it sees the payload only after the scope has matched, and rejects anything it
 * does not recognise.
 */
const openCursor = <A>(
  cursor: string,
  scope: CursorScope,
  shape: (payload: ReadonlyArray<unknown>) => A | undefined,
): Effect.Effect<A, CursorError> => {
  const failWithCursorError = (message: string) => Effect.fail(new CursorError({ message }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return failWithCursorError(NOT_OURS);
  }
  if (!Array.isArray(parsed) || parsed.length < 4) return failWithCursorError(NOT_OURS);
  const [op, field, direction, ...payload] = parsed as ReadonlyArray<unknown>;
  if (op !== scope.op) return failWithCursorError(NOT_OURS);
  if (field !== scope.field) return failWithCursorError(OTHER_LISTING);
  if (direction !== scope.direction) return failWithCursorError(OTHER_ORDER);
  const value = shape(payload);
  return value === undefined ? failWithCursorError(NOT_OURS) : Effect.succeed(value);
};

// Checks for a position SQLite can bind and compare as an integer. The
// `isSafeInteger` check matters: a hand-edited cursor with a larger number
// loses precision while parsing and becomes a float, which SQLite rejects.
const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Encodes the cursor for a row: its scope, sort key and id.
 *
 * The key keeps the type of its column. The next page compares the key against
 * that column, and SQLite sorts every number below every string. A numeric key
 * stored as text would make the boundary always false, and the list would end
 * after its first page with no error.
 */
export const encodeCursor = (scope: CursorScope, sortKey: SortKey, id: string): string =>
  sealCursor(scope, [sortKey, id]);

/**
 * Decodes a cursor from `encodeCursor` into its sort key and id. Fails with
 * `CursorError` if the cursor is malformed or belongs to another scope.
 *
 * `keyType` is the type of the sort column. A cursor whose key has the other
 * type is rejected rather than compared. SQLite sorts every number below every
 * string, so a key of the wrong type makes the boundary always true or always
 * false: the list silently restarts or silently ends. A cursor is opaque, so
 * the only way to get here is to edit one, and an edited cursor is rejected as
 * not issued by this operation.
 */
export const decodeCursor = (
  cursor: string,
  scope: CursorScope,
  keyType: "string" | "number",
): Effect.Effect<readonly [SortKey, string], CursorError> =>
  openCursor(cursor, scope, (payload) =>
    payload.length === 2 &&
    typeof payload[0] === keyType &&
    typeof payload[1] === "string" &&
    UUID_PATTERN.test(payload[1])
      ? ([payload[0] as SortKey, payload[1]] as const)
      : undefined,
  );

/**
 * Encodes the cursor for a row that has no id of its own. The cursor stores the
 * listing it belongs to, the row's sort key, the id of the record that owns the
 * row, and the row's name inside that record.
 */
export const encodeOwnedCursor = (
  scope: CursorScope,
  sortKey: string,
  ownerId: string,
  name: string,
): string => sealCursor(scope, [sortKey, ownerId, name]);

/**
 * Decodes a cursor from `encodeOwnedCursor` into its sort key, owner id and
 * name. Fails with `CursorError` if the cursor is malformed or was issued by
 * another listing.
 *
 * The sort key must be a string, because the only list that uses this cursor
 * sorts on a timestamp. `decodeCursor` explains why a key of the wrong type is
 * rejected.
 */
export const decodeOwnedCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<readonly [string, string, string], CursorError> =>
  openCursor(cursor, scope, (payload) =>
    payload.length === 3 &&
    typeof payload[0] === "string" &&
    typeof payload[1] === "string" &&
    UUID_PATTERN.test(payload[1]) &&
    typeof payload[2] === "string"
      ? ([payload[0], payload[1], payload[2]] as const)
      : undefined,
  );

/** Encodes the cursor for a list sorted by integer id: the id of the page's last row. */
export const encodeIdCursor = (scope: CursorScope, id: number): string =>
  sealCursor(scope, ["id", id]);

/**
 * Decodes a cursor from `encodeIdCursor` into its id. Fails with `CursorError`
 * if the cursor is malformed or belongs to another scope.
 */
export const decodeIdCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<number, CursorError> =>
  openCursor(cursor, scope, (payload) =>
    payload.length === 2 && payload[0] === "id" && isPosition(payload[1]) ? payload[1] : undefined,
  );

/**
 * Encodes the cursor for a list sorted by relevance: how many rows it has
 * already returned. Rows that change between pages shift the boundary. That is
 * the cost of sorting by a rank that is not stored on the row.
 */
export const encodeOffsetCursor = (scope: CursorScope, offset: number): string =>
  sealCursor(scope, ["offset", offset]);

/**
 * Builds the two SQL fragments a keyset query needs: the `WHERE` condition for
 * the cursor's boundary, and the `ORDER BY` clause.
 *
 * `columns` is the sort key, most significant first and the row's own id last.
 * `after` holds the value of each column on the last row of the previous page.
 * The columns are SQL text rather than identifiers because a key can be an
 * expression, such as the priority rank, and it has to be written exactly the
 * way the index that serves it was built.
 *
 * The boundary is a row-value comparison, so SQLite can resume with one index
 * seek: `(a, b) > (x, y)` reads along the index from that pair rather than
 * filtering out every row before it.
 */
export const buildKeyset = (
  sql: SqlClient.SqlClient,
  columns: ReadonlyArray<string>,
  after: ReadonlyArray<unknown> | undefined,
  direction: "asc" | "desc",
): { readonly keyset: Fragment; readonly order: Fragment } => {
  const ascending = direction === "asc";
  const key = sql.literal(columns.join(", "));
  const values = sql.csv((after ?? []).map((value) => sql`${value}`));
  return {
    // The first page has no boundary, so the condition is one every row
    // passes. The caller can then always add this fragment to its `WHERE`,
    // with or without a cursor.
    keyset:
      after === undefined
        ? sql`1 = 1`
        : ascending
          ? sql`(${key}) > (${values})`
          : sql`(${key}) < (${values})`,
    order: sql.literal(
      `ORDER BY ${columns.map((column) => `${column} ${ascending ? "ASC" : "DESC"}`).join(", ")}`,
    ),
  };
};

/**
 * Builds one page from the rows a keyset query read.
 *
 * The query reads one row more than the caller asked for. If that extra row
 * came back, there is a next page, so no list needs a count query. `items`
 * converts the page's rows into the values the caller receives. It returns an
 * effect because a row can need a second query to become a value. `cursorOf`
 * encodes the last value into the cursor the next page starts from.
 *
 * `items` must return one value per row, in the same order. The cursor is built
 * from the last value because that value holds the sort key. So an `items` that
 * dropped a row would start the next page from the wrong place, and one that
 * dropped the last row would end the list with no cursor and no error, the
 * silent end `decodeCursor` warns about. Every caller maps every row; the
 * `undefined` check below is only there because the generic type requires it.
 */
export const buildPage = <Row, A, E, R>(
  rows: ReadonlyArray<Row>,
  limit: number,
  items: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, E, R>,
  cursorOf: (last: A) => string,
): Effect.Effect<Page<A>, E, R> =>
  Effect.map(items(rows.slice(0, limit)), (page) => {
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : undefined,
    };
  });

/**
 * Decodes a cursor from `encodeOffsetCursor` into its offset. Fails with
 * `CursorError` if the cursor is malformed or belongs to another scope.
 */
export const decodeOffsetCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<number, CursorError> =>
  openCursor(cursor, scope, (payload) =>
    payload.length === 2 && payload[0] === "offset" && isPosition(payload[1])
      ? payload[1]
      : undefined,
  );

/**
 * Builds the schema fields for the three paging parameters every `query`
 * operation takes, limited to that operation's own sort fields. The result is
 * spread into a service's input struct.
 *
 * The contract declares the same three parameters in their HTTP form, where
 * `sort` is one string because a URL query can only hold strings. A service is
 * called both by a transport that has already decoded that string and by a
 * workflow action that never had one, so the service takes the decoded field
 * and direction, not the string.
 */
export const buildPageInputFields = <const Fields extends ReadonlyArray<string>>(
  fields: Fields,
) => ({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString),
  sort: Schema.optionalKey(
    Schema.Struct({
      field: Schema.Literals(fields),
      direction: Schema.optionalKey(SortDirection),
    }),
  ),
});

/**
 * Converts a `CursorError` into a `validation` error on the `cursor` parameter,
 * which tells the caller what to fix. Every list operation reports a bad cursor
 * the same way: the repository fails with `CursorError`, and the service that
 * owns the operation converts it with this function.
 */
export const refuseCursor = <A, E, R>(
  effect: Effect.Effect<A, E | CursorError, R>,
): Effect.Effect<A, Exclude<E, CursorError> | Validation, R> =>
  Effect.catchIf(
    effect,
    (error): error is CursorError => error instanceof CursorError,
    (error) => Effect.fail(createValidationError([{ path: ["cursor"], message: error.message }])),
  ) as Effect.Effect<A, Exclude<E, CursorError> | Validation, R>;
