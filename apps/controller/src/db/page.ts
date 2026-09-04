/**
 * Keyset paging, shared by every listing.
 *
 * A cursor is the sort key of the page's last row plus that row's id, opaque on
 * the wire. The pair is unique because the id alone already is, so a page
 * boundary never repeats or skips a row - which is why the API needs no page
 * numbers and no totals. A cursor is base64url over JSON, so a sort key holding
 * any character at all still has exactly one reading.
 *
 * A cursor also carries the listing that issued it and the order that listing
 * walked: `[op, field, direction, key, id]`. Without them a cursor is just two
 * strings, and one listing's cursor decodes cleanly in another - a secrets
 * cursor holding a name compares against `created_at` and quietly returns a
 * page whose boundary means nothing. The tag turns every such replay, including
 * the same listing walked under a different sort, into one `validation` error.
 *
 * Three cursor shapes exist, because three kinds of walk do. Two are keyset:
 * over a sort key plus a UUID, and over an integer id alone, which is what the
 * event log sorts by. The third is an offset, which relevance-ordered full-text
 * results need because a bm25 rank is not a stable key to resume from. The two
 * that carry a bare number name their kind inside the cursor, so an offset can
 * never be read back as an id: the two mean different things and the scope tag
 * alone would not always tell them apart.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OperationId } from "@hydra/contract";
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
  if (field !== scope.field || direction !== scope.direction) return refuse(OTHER_ORDER);
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
 */
export const decodeCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<readonly [SortKey, string], CursorError> =>
  open(cursor, scope, (payload) =>
    payload.length === 2 &&
    (typeof payload[0] === "string" || typeof payload[0] === "number") &&
    typeof payload[1] === "string" &&
    UUID_PATTERN.test(payload[1])
      ? ([payload[0], payload[1]] as const)
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
