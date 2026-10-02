/**
 * Keyset paging, shared by every list operation.
 *
 * A cursor holds the sort values of the page's last row, one per sort key,
 * plus that row's id, and is opaque to the client. The values together with the
 * id are unique because the id alone is unique, so a page boundary never
 * repeats or skips a row. That is why the API needs no page numbers and no
 * totals.
 *
 * This guarantee holds only while the sort values do not change. A row whose
 * value is updated between two pages moves to wherever the new value puts it,
 * ahead of the cursor or behind it. A client that must see every row exactly
 * once should sort by a field that never changes. A cursor is base64url-encoded
 * JSON, so a sort value can contain any character and still decode to exactly
 * one value.
 *
 * A cursor also holds the operation that issued it and the sort keys it used:
 * `[op, sort, ...payload]`, where `sort` is the list of `{ field, direction }`
 * keys. Without them a cursor would be just a few values, and one operation's
 * cursor would decode cleanly in another. For example, a secrets cursor holding
 * a name would be compared against `created_at` and quietly return a page with
 * a meaningless boundary. With the operation and sort keys in the cursor, every
 * such mismatch, including the same operation with different keys, fails with
 * one `validation` error.
 *
 * There are four kinds of cursor, one per kind of list:
 *
 * - keyset over the sort values plus a UUID;
 * - keyset over a sort value plus the UUID of the record that owns the row and
 *   the row's name inside that record. A trigger has no id of its own, so it
 *   is identified this way;
 * - keyset over an integer id alone, which is what the event log sorts by;
 * - an offset, which relevance-ordered full-text results need because a bm25
 *   rank is not a stable key to resume from.
 *
 * The integer-id and offset cursors both hold a bare number, so each one also
 * stores its kind inside the cursor. An offset can then never be read back as
 * an id. The operation and sort keys alone would not always tell the two
 * apart.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  MAX_PAGE_LIMIT,
  SortDirection,
  createValidationError,
  refuseRepeatedSortField,
  type OperationId,
  type SortKey,
  type Validation,
} from "@hercule/contract";
import { UUID_PATTERN, uuidFromString } from "./id";

/** One page of a keyset list. `nextCursor` is `undefined` on the last page. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
}

/**
 * The paging input of a listing that sorts by one field: how many rows, where
 * to start, and which direction.
 */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

/**
 * A sort key after the defaults are applied: the field and the direction a
 * listing actually sorts by. A key the caller sent without a direction
 * resolves to `asc`.
 */
export interface ResolvedSortKey<Field extends string = string> {
  readonly field: Field;
  readonly direction: SortDirection;
}

/**
 * The query a cursor belongs to: the operation and the sort keys it used, in
 * order and with their directions. A cursor is only valid for exactly the same
 * query.
 *
 * A listing that is not sorted by a column has no field name to put in a key.
 * It puts whatever its rows depend on in the key's `field` instead:
 *
 * - a relevance search puts its search text there;
 * - a transcript, or the inputs of a session, puts the session id there;
 * - the messages of a conversation put the conversation id there.
 *
 * Otherwise page two of one search would resume inside the results of another,
 * which is the mistake this scope exists to prevent.
 */
export interface CursorScope {
  readonly op: OperationId;
  readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey>;
}

/** A cursor that was not issued by this operation, or was edited by the client. */
export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String,
}) {}

const NOT_OURS = "The cursor is not one this listing issued.";
const OTHER_ORDER = "The cursor was issued under a different sort order.";

/**
 * The error message for a cursor whose fields do not match. It differs from
 * the message for a wrong direction because a key's `field` is not always a
 * column name. It can also hold the session a transcript position belongs to,
 * or the text a relevance search looked for. "A different sort order" would
 * then send the caller to check `--sort` when it is the list itself that
 * changed.
 */
const OTHER_LISTING = "The cursor was issued for a different listing.";

/** A sort value in a cursor: the value of one sort column on a row. */
export type SortValue = string | number;

/**
 * The type of one sort column's values. A cursor value is checked against it,
 * so the next page compares the value the same way as the column. A `number`
 * is always an integer, because every numeric sort column holds a rank or a
 * position.
 */
export type SortValueType = "string" | "number";

/**
 * How a listing sorts by one of its sortable fields. A listing that sorts by
 * more than one field keeps a table of these, one per field, so the column,
 * the type of its values and the reading of a value from an item never
 * disagree.
 */
export interface SortColumn<Item> {
  /**
   * The SQL the listing orders by: a column, or an expression such as a rank.
   * An expression is written exactly as the index that serves it, because
   * SQLite uses an expression index only for the same expression.
   */
  readonly column: string;
  /** The type of the value in a cursor, which `decodeCursor` checks. */
  readonly valueType: SortValueType;
  /** Returns the item's value for the column, to put in the next page's cursor. */
  readonly readValue: (item: Item) => SortValue;
}

/** Checks that a value read back from a cursor is a list of resolved sort keys. */
const isSealedSort = Schema.is(
  Schema.Array(Schema.Struct({ field: Schema.String, direction: SortDirection })),
);

const sealCursor = (scope: CursorScope, payload: ReadonlyArray<SortValue>): string =>
  Buffer.from(
    JSON.stringify([
      scope.op,
      // Only the two properties are copied, so an object with more properties
      // still seals to the same cursor.
      scope.sort.map(({ field, direction }) => ({ field, direction })),
      ...payload,
    ]),
    "utf8",
  ).toString("base64url");

/**
 * Decodes a cursor and returns its payload, parsed by `shape`. Fails with
 * `CursorError` when:
 *
 * - the cursor does not decode, or another operation issued it (`NOT_OURS`);
 * - it sorts by other fields, or by the same fields in another order
 *   (`OTHER_LISTING`);
 * - it sorts by the same fields in other directions (`OTHER_ORDER`);
 * - `shape` returns `undefined` (`NOT_OURS`).
 *
 * The fields are compared before any direction, so a cursor that differs in
 * both is reported as a different listing, which is the larger change.
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
  if (!Array.isArray(parsed) || parsed.length < 3) return failWithCursorError(NOT_OURS);
  const [op, sort, ...payload] = parsed as ReadonlyArray<unknown>;
  // A cursor issued before the sort became a list holds a field name here, so
  // it is refused as not ours and the caller starts again from the first page.
  if (op !== scope.op || !isSealedSort(sort)) return failWithCursorError(NOT_OURS);
  if (
    sort.length !== scope.sort.length ||
    sort.some((key, index) => key.field !== scope.sort[index]?.field)
  ) {
    return failWithCursorError(OTHER_LISTING);
  }
  if (sort.some((key, index) => key.direction !== scope.sort[index]?.direction)) {
    return failWithCursorError(OTHER_ORDER);
  }
  const value = shape(payload);
  return value === undefined ? failWithCursorError(NOT_OURS) : Effect.succeed(value);
};

// Checks for a position SQLite can bind and compare as an integer. The
// `isSafeInteger` check matters: a hand-edited cursor with a larger number
// loses precision while parsing and becomes a float, which SQLite rejects.
const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Checks that a value read back from a cursor has the type of its sort column.
 * A number must be a safe integer, for the same reason as a position: an
 * edited cursor could otherwise hold a fraction, or a number too large to
 * parse exactly, that no rank or position ever has.
 */
const isSortValueOfType = (value: unknown, valueType: SortValueType): value is SortValue =>
  valueType === "number" ? Number.isSafeInteger(value) : typeof value === "string";

/**
 * Encodes the cursor for a row: its scope, its sort values and its id.
 * `values` holds one value per sort key of `scope`, in the same order.
 *
 * Each value keeps the type of its column. The next page compares the value
 * against that column, and SQLite sorts every number below every string. A
 * numeric value stored as text would make the boundary always false, and the
 * list would end after its first page with no error.
 */
export const encodeCursor = (
  scope: CursorScope,
  values: ReadonlyArray<SortValue>,
  id: string,
): string => sealCursor(scope, [...values, id]);

/**
 * Decodes a cursor from `encodeCursor` and returns its sort values, one per
 * sort key and in the same order, and the row's id. Fails with `CursorError`
 * if the cursor is malformed or belongs to another scope.
 *
 * `valueTypes` holds the type of each sort column, one per sort key. A cursor
 * is rejected rather than compared when it has another number of values, a
 * value of the other type, or a number that is not a safe integer. SQLite
 * sorts every number below every string, so a value of the wrong type makes
 * the boundary always true or always false: the list silently restarts or
 * silently ends. A cursor is opaque, so the only way to get here is to edit
 * one, and an edited cursor is rejected as not issued by this operation.
 */
export const decodeCursor = (
  cursor: string,
  scope: CursorScope,
  valueTypes: ReadonlyArray<SortValueType>,
): Effect.Effect<{ readonly values: ReadonlyArray<SortValue>; readonly id: string }, CursorError> =>
  openCursor(cursor, scope, (payload) => {
    const values = payload.slice(0, -1);
    const id = payload[payload.length - 1];
    return payload.length === valueTypes.length + 1 &&
      valueTypes.every((valueType, index) => isSortValueOfType(values[index], valueType)) &&
      typeof id === "string" &&
      UUID_PATTERN.test(id)
      ? { values: values as ReadonlyArray<SortValue>, id }
      : undefined;
  });

/**
 * Encodes the cursor for a row that has no id of its own. The cursor stores the
 * listing it belongs to, the row's sort value, the id of the record that owns
 * the row, and the row's name inside that record.
 */
export const encodeOwnedCursor = (
  scope: CursorScope,
  value: string,
  ownerId: string,
  name: string,
): string => sealCursor(scope, [value, ownerId, name]);

/**
 * Decodes a cursor from `encodeOwnedCursor` into its sort value, owner id and
 * name. Fails with `CursorError` if the cursor is malformed or was issued by
 * another listing.
 *
 * The sort value must be a string, because the only list that uses this
 * cursor sorts on a timestamp. `decodeCursor` explains why a value of the wrong
 * type is rejected.
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

/**
 * Encodes the cursor for a list sorted by one unique integer column, such as
 * an event's id or a message's position: that column's value on the page's
 * last row. The scope's one sort key names the column; the payload holds only
 * its value, tagged `key` so it is never read as an offset cursor.
 */
export const encodeIntegerKeyCursor = (scope: CursorScope, value: number): string =>
  sealCursor(scope, ["key", value]);

/**
 * Decodes a cursor from `encodeIntegerKeyCursor` into its integer key. Fails
 * with `CursorError` if the cursor is malformed or belongs to another scope.
 */
export const decodeIntegerKeyCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<number, CursorError> =>
  openCursor(cursor, scope, (payload) =>
    payload.length === 2 && payload[0] === "key" && isPosition(payload[1]) ? payload[1] : undefined,
  );

/**
 * Encodes the cursor for a list sorted by relevance: how many rows it has
 * already returned. Rows that change between pages shift the boundary. That is
 * the cost of sorting by a rank that is not stored on the row.
 */
export const encodeOffsetCursor = (scope: CursorScope, offset: number): string =>
  sealCursor(scope, ["offset", offset]);

/**
 * One column a keyset query sorts by, with its direction. `column` is SQL text
 * rather than an identifier because a sort column can be an expression, such
 * as the priority rank, and it has to be written exactly the way the index
 * that serves it was built.
 */
export interface KeysetColumn {
  readonly column: string;
  readonly direction: SortDirection;
}

/**
 * Builds the two SQL fragments a keyset query needs: the `WHERE` condition for
 * the cursor's boundary, and the `ORDER BY` clause.
 *
 * - `keys` holds the sort columns, most significant first, each with its own
 *   direction.
 * - `tieBreak` holds the columns that make a row's position unique, usually
 *   the row's id. They take the direction of the last key, so every listing
 *   breaks ties the same way. It is empty when the last key is already unique,
 *   such as a message's position.
 * - `after` holds the values of the last row of the previous page: one per
 *   key, then one per tie-break column. It is `undefined` on the first page.
 *
 * When every key has the same direction, the boundary is a row-value
 * comparison, `(a, b) > (x, y)`, preceded by a plain range on the first
 * column, `a >= x`. The range is what lets SQLite resume with an index seek
 * when the first column is an expression, such as the rank of a priority or a
 * status: SQLite seeks an expression index from a plain range, but not from a
 * row-value comparison. Without the range, each page would read the index
 * from the start and skip every row before the boundary.
 *
 * With mixed directions no single comparison fits, so the boundary is written
 * out column by column, each in its own direction. For `p desc, c asc` and the
 * id: `(p < ?p OR (p = ?p AND (c > ?c OR (c = ?c AND id > ?id))))`. No index
 * serves a sort in mixed directions, so this form does not try to seek.
 *
 * Both forms rely on every sort column being `NOT NULL`, which every sortable
 * column is today. A comparison with `NULL` is never true, so a row with a
 * `NULL` sort value would never appear after the first page.
 */
export const buildKeyset = (
  sql: SqlClient.SqlClient,
  keys: Arr.NonEmptyReadonlyArray<KeysetColumn>,
  tieBreak: ReadonlyArray<string>,
  after: ReadonlyArray<unknown> | undefined,
): { readonly keyset: Fragment; readonly order: Fragment } => {
  const lastDirection = Arr.lastNonEmpty(keys).direction;
  const columns = Arr.appendAll(
    keys,
    tieBreak.map((column) => ({ column, direction: lastDirection })),
  );
  const order = sql.literal(
    `ORDER BY ${columns
      .map(({ column, direction }) => `${column} ${direction === "asc" ? "ASC" : "DESC"}`)
      .join(", ")}`,
  );
  // The first page has no boundary, so the condition is one every row passes.
  // The caller can then always add this fragment to its `WHERE`, with or
  // without a cursor.
  if (after === undefined) return { keyset: sql`1 = 1`, order };
  const chooseComparison = (direction: SortDirection) =>
    sql.literal(direction === "asc" ? ">" : "<");
  if (columns.every(({ direction }) => direction === lastDirection)) {
    const first = sql.literal(Arr.headNonEmpty(columns).column);
    const range = sql`${first} ${sql.literal(lastDirection === "asc" ? ">=" : "<=")} ${after[0]}`;
    const key = sql.literal(columns.map(({ column }) => column).join(", "));
    const values = sql.csv(after.map((value) => sql`${value}`));
    const rowValue = sql`(${key}) ${chooseComparison(lastDirection)} (${values})`;
    return { keyset: sql`${range} AND ${rowValue}`, order };
  }
  // Built from the last column outwards: each column's condition wraps the
  // conditions of the columns after it in parentheses. The outermost
  // parentheses keep the `OR` inside, because callers join this fragment to
  // their own conditions with `AND`.
  const compareBeyond = ({ column, direction }: KeysetColumn, index: number) =>
    sql`${sql.literal(column)} ${chooseComparison(direction)} ${after[index]}`;
  const keyset = Arr.initNonEmpty(columns).reduceRight<Fragment>(
    (inner, column, index) => {
      const sameValue = sql`${sql.literal(column.column)} = ${after[index]}`;
      return sql`(${compareBeyond(column, index)} OR (${sameValue} AND ${inner}))`;
    },
    compareBeyond(Arr.lastNonEmpty(columns), columns.length - 1),
  );
  return { keyset, order };
};

/**
 * Decodes the cursor of a listing sorted by the keys in `sort`, and returns
 * what its keyset query needs:
 *
 * - `keyset` and `order`, the two fragments from `buildKeyset`;
 * - `encodeNextCursor`, which encodes the cursor of the page that starts after
 *   an item.
 *
 * `columns` is the listing's table of sort columns. `idColumn` is the column
 * that holds the row's id as a UUID; it breaks the ties the sort keys leave.
 * With no `cursor`, the boundary lets every row through. Fails with
 * `CursorError` if the cursor is malformed or was issued for another operation
 * or other sort keys.
 */
export const prepareKeysetListing = <Field extends string, Item extends { readonly id: string }>(
  sql: SqlClient.SqlClient,
  op: OperationId,
  sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<Field>>,
  columns: Record<Field, SortColumn<Item>>,
  idColumn: string,
  cursor: string | undefined,
): Effect.Effect<
  {
    readonly keyset: Fragment;
    readonly order: Fragment;
    readonly encodeNextCursor: (item: Item) => string;
  },
  CursorError
> =>
  Effect.gen(function* () {
    const scope: CursorScope = { op, sort };
    const after =
      cursor === undefined
        ? undefined
        : yield* decodeCursor(
            cursor,
            scope,
            sort.map(({ field }) => columns[field].valueType),
          );
    const { keyset, order } = buildKeyset(
      sql,
      Arr.map(sort, ({ field, direction }) => ({ column: columns[field].column, direction })),
      [idColumn],
      after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
    );
    return {
      keyset,
      order,
      encodeNextCursor: (item: Item) =>
        encodeCursor(
          scope,
          sort.map(({ field }) => columns[field].readValue(item)),
          item.id,
        ),
    };
  });

/**
 * Builds one page from the rows a keyset query read.
 *
 * The query reads one row more than the caller asked for. If that extra row
 * came back, there is a next page, so no list needs a count query. `items`
 * converts the page's rows into the values the caller receives. It returns an
 * effect because a row can need a second query to become a value. `encodeNextCursor`
 * encodes the last value into the cursor the next page starts from.
 *
 * `items` must return one value per row, in the same order. The cursor is built
 * from the last value because that value holds the sort values. So an `items` that
 * dropped a row would start the next page from the wrong place, and one that
 * dropped the last row would end the list with no cursor and no error, the
 * silent end `decodeCursor` warns about. Every caller maps every row; the
 * `undefined` check below is only there because the generic type requires it.
 */
export const buildPage = <Row, A, E, R>(
  rows: ReadonlyArray<Row>,
  limit: number,
  items: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, E, R>,
  encodeNextCursor: (last: A) => string,
): Effect.Effect<Page<A>, E, R> =>
  Effect.map(items(rows.slice(0, limit)), (page) => {
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: rows.length > limit && last !== undefined ? encodeNextCursor(last) : undefined,
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
 * each sort key is one string because a URL query can only hold strings. A
 * service is called both by a transport that has already decoded those
 * strings and by a workflow action that never had them, so the service takes
 * the decoded list of `{ field, direction }` keys, not the strings. The list
 * has the same bound and the same repeat check as the contract's.
 */
export const buildPageInputFields = <const Fields extends ReadonlyArray<string>>(
  fields: Fields,
) => ({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString),
  sort: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        field: Schema.Literals(fields),
        direction: Schema.optionalKey(SortDirection),
      }),
    ).check(refuseRepeatedSortField, Schema.isMaxLength(fields.length)),
  ),
});

/**
 * Checks whether the caller sent at least one sort key. An empty list counts
 * as no sort at all, because the wire cannot tell the two apart: an empty
 * list writes no query parameter.
 */
export const hasSortKeys = <Key>(
  sort: ReadonlyArray<Key> | undefined,
): sort is Arr.NonEmptyReadonlyArray<Key> =>
  sort !== undefined && Arr.isReadonlyArrayNonEmpty(sort);

/**
 * Returns the sort keys a listing sorts by: `defaultKeys` when the caller sent
 * none (see `hasSortKeys`), and otherwise the caller's keys in order, with a
 * missing direction set to `asc`.
 */
export const resolveSortKeys = <Field extends string>(
  sort: ReadonlyArray<SortKey<Field>> | undefined,
  defaultKeys: Arr.NonEmptyReadonlyArray<ResolvedSortKey<Field>>,
): Arr.NonEmptyReadonlyArray<ResolvedSortKey<Field>> =>
  hasSortKeys(sort)
    ? Arr.map(sort, ({ field, direction }) => ({ field, direction: direction ?? "asc" }))
    : defaultKeys;

/**
 * Returns the direction of a listing that sorts by one field: the direction of
 * the caller's one key, `asc` when that key has none, and `defaultDirection`
 * when the caller sent no key.
 */
export const resolveSortDirection = (
  sort: ReadonlyArray<SortKey> | undefined,
  defaultDirection: SortDirection,
): SortDirection => {
  const [key] = sort ?? [];
  return key === undefined ? defaultDirection : (key.direction ?? "asc");
};

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
