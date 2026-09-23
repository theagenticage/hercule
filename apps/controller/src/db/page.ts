/**
 * Keyset paging, shared by every listing.
 *
 * A cursor is the sort key of the page's last row plus that row's id, opaque on
 * the wire. The pair is unique because the id alone already is, so a page
 * boundary never repeats or skips a row - which is why the API needs no page
 * numbers and no totals. That guarantee is over a sort key the walk does not
 * mutate: a row whose key is rewritten between two pages moves to wherever the
 * new key puts it, ahead of the cursor or behind it, and a walker who needs to
 * see every row exactly once orders by a key nothing rewrites. A cursor is
 * base64url over JSON, so a sort key holding any character at all still has
 * exactly one reading.
 *
 * A cursor also carries the listing that issued it and the order that listing
 * walked: `[op, field, direction, key, id]`. Without them a cursor is just two
 * strings, and one listing's cursor decodes cleanly in another - a secrets
 * cursor holding a name compares against `created_at` and quietly returns a
 * page whose boundary means nothing. The tag turns every such replay, including
 * the same listing walked under a different sort, into one `validation` error.
 *
 * Four cursor shapes exist, because four kinds of walk do. Three are keyset:
 * over a sort key plus a UUID; over a sort key plus the UUID of the record that
 * owns the row and the row's name inside that record, which is how a trigger is
 * named; and over an integer id alone, which is what the event log sorts by.
 * The fourth is an offset, which relevance-ordered full-text results need
 * because a bm25 rank is not a stable key to resume from. The two that carry a
 * bare number name their kind inside the cursor, so an offset can never be read
 * back as an id: the two mean different things and the scope tag alone would
 * not always tell them apart.
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

/** One page of a keyset listing. `nextCursor` is `undefined` on the last page. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
}

/** What a listing needs: how many, where from, which way. */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: "asc" | "desc";
}

/**
 * The walk a cursor belongs to: the operation, the field it sorts on and the
 * direction it runs. A cursor is only valid for the identical walk.
 *
 * A walk whose order is not a column - relevance over a search text - has no
 * field name to put here, and must put what its order depends on in `field`
 * instead. Otherwise page two of one search resumes inside the results of
 * another, which is the failure this scope exists to prevent.
 */
export interface CursorScope {
  readonly op: OperationId;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** A cursor that did not come from this listing, or was edited on its way back. */
export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String,
}) {}

const NOT_OURS = "The cursor is not one this listing issued.";
const OTHER_ORDER = "The cursor was issued under a different sort order.";

/**
 * A cursor whose walk sorts on something else. Told apart from the direction
 * because `field` carries what a walk's order depends on and not only a column
 * name - the session a transcript position belongs to, the text a relevance
 * walk searched for - so "a different sort order" would send the caller looking
 * at `--sort` when the listing itself is the thing that changed.
 */
const OTHER_LISTING = "The cursor was issued for a different listing.";

/** The parts a cursor carries after the walk it belongs to. */
type Payload = ReadonlyArray<string | number>;

/** A sort key on the wire: whatever the ordered column holds. */
export type SortKey = string | number;

const seal = (scope: CursorScope, payload: Payload): string =>
  Buffer.from(
    JSON.stringify([scope.op, scope.field, scope.direction, ...payload]),
    "utf8",
  ).toString("base64url");

/**
 * The payload of a cursor that belongs to this walk. `shape` is what makes a
 * cursor of one kind unreadable as another: it sees the payload only after the
 * walk matched, and rejects anything it does not recognise.
 */
const open = <A>(
  cursor: string,
  scope: CursorScope,
  shape: (payload: ReadonlyArray<unknown>) => A | undefined,
): Effect.Effect<A, CursorError> => {
  const refuse = (message: string) => Effect.fail(new CursorError({ message }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return refuse(NOT_OURS);
  }
  if (!Array.isArray(parsed) || parsed.length < 4) return refuse(NOT_OURS);
  const [op, field, direction, ...payload] = parsed as ReadonlyArray<unknown>;
  if (op !== scope.op) return refuse(NOT_OURS);
  if (field !== scope.field) return refuse(OTHER_LISTING);
  if (direction !== scope.direction) return refuse(OTHER_ORDER);
  const value = shape(payload);
  return value === undefined ? refuse(NOT_OURS) : Effect.succeed(value);
};

// A position SQLite can bind and compare as an integer. `isSafeInteger` is the
// bound that matters: past it a hand-edited cursor loses precision on the way
// in and lands as a float, which SQLite refuses.
const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The cursor for a row: the walk it belongs to, its sort key and its id. The
 * key keeps the type the column has, because a keyset resume compares it
 * against that column and SQLite orders every number below every string: a
 * numeric key handed back as text makes the boundary always false, and the walk
 * ends after its first page with no error to show for it.
 */
export const encodeCursor = (scope: CursorScope, sortKey: SortKey, id: string): string =>
  seal(scope, [sortKey, id]);

/**
 * The sort key and id a cursor names, or `CursorError` if it names neither or
 * belongs to another walk.
 *
 * `keyType` is what the ordered column holds, and a cursor whose key is of the
 * other type is refused rather than compared. SQLite orders every number below
 * every string, so a key of the wrong type makes the boundary either always
 * true or always false: the walk silently restarts or silently ends, with
 * nothing to show for it. A cursor is opaque, so the only way to reach this is
 * to edit one, and the answer to an edited cursor is that it is not ours.
 */
export const decodeCursor = (
  cursor: string,
  scope: CursorScope,
  keyType: "string" | "number",
): Effect.Effect<readonly [SortKey, string], CursorError> =>
  open(cursor, scope, (payload) =>
    payload.length === 2 &&
    typeof payload[0] === keyType &&
    typeof payload[1] === "string" &&
    UUID_PATTERN.test(payload[1])
      ? ([payload[0] as SortKey, payload[1]] as const)
      : undefined,
  );

/**
 * The cursor for a row that has no id of its own: the walk it belongs to, its
 * sort key, the id of the record that owns it, and its name inside that record.
 */
export const encodeOwnedCursor = (
  scope: CursorScope,
  sortKey: string,
  ownerId: string,
  name: string,
): string => seal(scope, [sortKey, ownerId, name]);

/**
 * The sort key, owner id and name an owned-row cursor carries, or
 * `CursorError` if it carries none or belongs to another walk. The one walk
 * that uses it sorts on a timestamp, so the key is text, and a key of another
 * type is refused for the reason `decodeCursor` gives.
 */
export const decodeOwnedCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<readonly [string, string, string], CursorError> =>
  open(cursor, scope, (payload) =>
    payload.length === 3 &&
    typeof payload[0] === "string" &&
    typeof payload[1] === "string" &&
    UUID_PATTERN.test(payload[1]) &&
    typeof payload[2] === "string"
      ? ([payload[0], payload[1], payload[2]] as const)
      : undefined,
  );

/** The cursor for a walk over integer ids: the id of the page's last row. */
export const encodeIdCursor = (scope: CursorScope, id: number): string => seal(scope, ["id", id]);

/** The id a cursor names, or `CursorError` if it names none or belongs to another walk. */
export const decodeIdCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<number, CursorError> =>
  open(cursor, scope, (payload) =>
    payload.length === 2 && payload[0] === "id" && isPosition(payload[1]) ? payload[1] : undefined,
  );

/**
 * The cursor for a relevance walk: how many rows it has already handed out.
 * Rows that change under a walk shift its boundary, which is the cost of
 * ordering by a rank no row carries.
 */
export const encodeOffsetCursor = (scope: CursorScope, offset: number): string =>
  seal(scope, ["offset", offset]);

/**
 * The two fragments a keyset walk adds to its query: the boundary the cursor
 * names, and the order to read in.
 *
 * `columns` is the key the walk runs on, most significant first and the row's
 * own id last, and `after` holds the value each of them had on the last row of
 * the previous page. They arrive as SQL text rather than as identifiers because
 * a key can be an expression - the priority rank - and it has to be spelled
 * exactly the way the index that serves it was built.
 *
 * The boundary is a row-value comparison, which is what lets one index seek
 * answer the resume: `(a, b) > (x, y)` reads along the index from that pair
 * rather than filtering out every row before it.
 */
export const keysetOver = (
  sql: SqlClient.SqlClient,
  columns: ReadonlyArray<string>,
  after: ReadonlyArray<unknown> | undefined,
  direction: "asc" | "desc",
): { readonly keyset: Fragment; readonly order: Fragment } => {
  const ascending = direction === "asc";
  const key = sql.literal(columns.join(", "));
  const values = sql.csv((after ?? []).map((value) => sql`${value}`));
  return {
    // A walk that starts at the beginning has no boundary, and says so as a
    // condition every row passes: the caller then ands one fragment into its
    // `WHERE` and reads the same query whether or not it was given a cursor.
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
 * One page out of the rows a keyset walk read.
 *
 * A walk asks for one row more than the caller wanted: whether that row came
 * back is whether there is a next page, which is why no listing needs a count
 * query to know. `items` turns the page's rows into what the caller reads -
 * effectful because a row can need a second query to become a value - and
 * `cursorOf` seals the last of them into the cursor the next page resumes from.
 *
 * `items` must be total and order-preserving: one value per row it was given,
 * in that order. The cursor is sealed off the last value because that is what
 * carries the sort key, so an `items` that dropped a row would resume the next
 * page from the wrong one - and one that dropped the last row would end the
 * walk with no cursor and no error, which is the silent end `decodeCursor`
 * warns about. Both callbacks in the tree map every row; the `undefined` guard
 * below is what the generic's own type demands, not a case that can arise.
 */
export const pageOf = <Row, A, E, R>(
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

/** The offset a cursor names, or `CursorError` if it names none or belongs to another walk. */
export const decodeOffsetCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<number, CursorError> =>
  open(cursor, scope, (payload) =>
    payload.length === 2 && payload[0] === "offset" && isPosition(payload[1])
      ? payload[1]
      : undefined,
  );

/**
 * The three parameters every `query` operation takes, over that operation's own
 * sort fields, ready to be spread into a service's input struct.
 *
 * The contract declares the same three, but as the wire carries them: `sort` is
 * one string there, because a URL query holds nothing else. A service is called
 * both by a transport that has already decoded that string and by a workflow
 * action that never had one, so what it decodes is the pair, not the string.
 */
export const pageInput = <const Fields extends ReadonlyArray<string>>(fields: Fields) => ({
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
 * A cursor a listing will not accept, said the way the caller can act on: the
 * `cursor` parameter is wrong. Every listing answers the same way, so the
 * repository raises `CursorError` and the service that owns the operation turns
 * it into the one `validation` error.
 */
export const refuseCursor = <A, E, R>(
  effect: Effect.Effect<A, E | CursorError, R>,
): Effect.Effect<A, Exclude<E, CursorError> | Validation, R> =>
  Effect.catchIf(
    effect,
    (error): error is CursorError => error instanceof CursorError,
    (error) => Effect.fail(createValidationError([{ path: ["cursor"], message: error.message }])),
  ) as Effect.Effect<A, Exclude<E, CursorError> | Validation, R>;
