/**
 * Pagination and sorting, identical on every `query` operation.
 *
 * Cursors are opaque strings; there are no page numbers and no total counts.
 * The allowed sort fields are declared per operation, so an unknown field is a
 * `validation` error rather than a silently ignored parameter.
 *
 * `sort` travels as one query parameter, `sort=<field>[:<asc|desc>]`, because a
 * URL query carries only strings: a nested object has no encoding every client
 * agrees on, and the one the derived client picks would be silently dropped as
 * an unknown parameter rather than rejected. The decoded value is still the
 * `{ field, direction }` pair from the spec, so callers work with an object and
 * only the wire carries the string. The direction is optional; each
 * operation's service declares its own default order.
 */
import { Schema, SchemaGetter } from "effect";

/** The page size a caller gets without asking. */
export const DEFAULT_PAGE_LIMIT = 50;

/** The largest page anyone may ask for. */
export const MAX_PAGE_LIMIT = 500;

export const SortDirection = Schema.Literals(["asc", "desc"]);

export type SortDirection = Schema.Schema.Type<typeof SortDirection>;

/** The annotation carrying an operation's sortable fields; `readSortFields` reads it. */
const SORT_FIELDS = "sortFields";

/**
 * One operation's `sort` parameter: `<field>[:<asc|desc>]` on the wire, over
 * that operation's own enum of sortable fields.
 */
export const sortParam = <const Fields extends ReadonlyArray<string>>(fields: Fields) => {
  const sort = Schema.Struct({
    field: Schema.Literals(fields),
    direction: Schema.optionalKey(SortDirection),
  });
  type Sort = typeof sort.Encoded;
  return Schema.String.pipe(
    Schema.decodeTo(sort, {
      // The split does not validate on purpose: its result is decoded by the
      // struct above, which turns an unknown field or direction into an issue
      // that points at that half of the parameter.
      decode: SchemaGetter.transform((text: string): Sort => {
        const colon = text.indexOf(":");
        return (
          colon === -1
            ? { field: text }
            : { field: text.slice(0, colon), direction: text.slice(colon + 1) }
        ) as Sort;
      }),
      encode: SchemaGetter.transform((value) =>
        value.direction === undefined ? value.field : `${value.field}:${value.direction}`,
      ),
    }),
  ).annotate({ [SORT_FIELDS]: fields });
};

/**
 * Returns the sort fields an operation's query schema declares, for a client
 * that has to show or validate them (the CLI's `--sort`). Returns an empty
 * list when the operation does not page.
 */
export const readSortFields = (query: unknown): ReadonlyArray<string> => {
  const ast = (
    query as
      | {
          ast?: {
            propertySignatures?: ReadonlyArray<{
              name: PropertyKey;
              type?: { annotations?: Record<string, unknown> };
            }>;
          };
        }
      | undefined
  )?.ast;
  const sort = ast?.propertySignatures?.find((property) => String(property.name) === "sort");
  const fields = sort?.type?.annotations?.[SORT_FIELDS];
  return Array.isArray(fields) ? (fields as ReadonlyArray<string>) : [];
};

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
    sort: Schema.optionalKey(sortParam(fields)),
  });

/** One page of results. `nextCursor` is absent on the last page. */
export const page = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optionalKey(Schema.NonEmptyString),
  });
