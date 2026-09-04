/**
 * Pagination and sorting, identical on every `query` operation
 * (spec 11 section 1.6).
 *
 * Cursors are opaque strings; there are no page numbers and no total counts.
 * The allowed sort fields are declared per operation, so an unknown field is a
 * `validation` error rather than a silently ignored parameter.
 */
import { Schema } from "effect";

/** The page size a caller gets without asking. */
export const DEFAULT_PAGE_LIMIT = 50;

/** The largest page anyone may ask for. */
export const MAX_PAGE_LIMIT = 500;

export const SortDirection = Schema.Literals(["asc", "desc"]);

export type SortDirection = Schema.Schema.Type<typeof SortDirection>;

/**
 * The pagination parameters of one `query` operation, over that operation's
 * own enum of sortable fields.
 */
export const pageParams = <const Fields extends ReadonlyArray<string>>(fields: Fields) =>
  Schema.Struct({
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    ),
    cursor: Schema.optionalKey(Schema.NonEmptyString),
    sort: Schema.optionalKey(
      Schema.Struct({ field: Schema.Literals(fields), direction: SortDirection }),
    ),
  });

/** One page of results. `nextCursor` is absent on the last page. */
export const page = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optionalKey(Schema.NonEmptyString),
  });
