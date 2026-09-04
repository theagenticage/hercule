/**
 * Keyset paging, shared by every listing (spec 11 section 1.6).
 *
 * A cursor is the sort key of the page's last row plus that row's id, opaque on
 * the wire. The pair is unique because the id alone already is, so a page
 * boundary never repeats or skips a row - which is why the API needs no page
 * numbers and no totals. A cursor is base64url over JSON, so a sort key holding
 * any character at all still has exactly one reading.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

/** A cursor that did not come from this listing, or was edited on its way back. */
export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String,
}) {}

const UUID = /^[0-9a-f-]{36}$/;

/** The cursor for a row: its sort key and its id. */
export const encodeCursor = (sortKey: string, id: string): string =>
  Buffer.from(JSON.stringify([sortKey, id]), "utf8").toString("base64url");

/** The sort key and id a cursor names, or `CursorError` if it names neither. */
export const decodeCursor = (
  cursor: string,
): Effect.Effect<readonly [string, string], CursorError> => {
  const refuse = Effect.fail(
    new CursorError({ message: "The cursor is not one this listing issued." }),
  );
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !UUID.test(parsed[1])
    ) {
      return refuse;
    }
    return Effect.succeed([parsed[0], parsed[1]] as const);
  } catch {
    return refuse;
  }
};
