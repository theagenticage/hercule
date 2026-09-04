/**
 * Keyset paging, shared by every listing (spec 11 section 1.6).
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

/** What a listing needs: how many, where from, which way (spec 11 section 1.6). */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: "asc" | "desc";
}

/**
 * The walk a cursor belongs to: the operation, the field it sorts on and the
 * direction it runs. A cursor is only valid for the identical walk.
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

/** The cursor for a row: the walk it belongs to, its sort key and its id. */
export const encodeCursor = (scope: CursorScope, sortKey: string, id: string): string =>
  Buffer.from(
    JSON.stringify([scope.op, scope.field, scope.direction, sortKey, id]),
    "utf8",
  ).toString("base64url");

/**
 * The sort key and id a cursor names, or `CursorError` if it names neither or
 * belongs to another walk.
 */
export const decodeCursor = (
  cursor: string,
  scope: CursorScope,
): Effect.Effect<readonly [string, string], CursorError> => {
  const refuse = (message: string) => Effect.fail(new CursorError({ message }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return refuse(NOT_OURS);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    parsed.some((part) => typeof part !== "string") ||
    !UUID_PATTERN.test(parsed[4] as string)
  ) {
    return refuse(NOT_OURS);
  }
  const [op, field, direction, key, id] = parsed as [string, string, string, string, string];
  if (op !== scope.op) return refuse(NOT_OURS);
  if (field !== scope.field || direction !== scope.direction) return refuse(OTHER_ORDER);
  return Effect.succeed([key, id] as const);
};
