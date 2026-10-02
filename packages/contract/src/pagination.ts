/**
 * Pagination and sorting, identical on every `query` operation.
 *
 * Cursors are opaque strings; there are no page numbers and no total counts.
 * The allowed sort fields are declared per operation, so an unknown field is a
 * `validation` error rather than a silently ignored parameter.
 *
 * `sort` is an ordered list of keys. Each key travels as one query parameter,
 * `sort=<field>[:<asc|desc>]`, and a list of several keys repeats the
 * parameter, one per key, in order:
 * `sort=priority:desc&sort=createdAt:desc`. A list of one key is a single
 * parameter. A key is a string on the wire because a URL query carries only
 * strings: a nested object has no encoding every client agrees on, and the one
 * the derived client picks would be silently dropped as an unknown parameter
 * rather than rejected. The decoded value is still a list of
 * `{ field, direction }` objects, so callers work with objects and only the
 * wire carries the strings.
 *
 * What the keys mean:
 *
 * - The first key sorts the list. Each later key orders only the rows that are
 *   equal on all the keys before it.
 * - After the caller's keys, rows are ordered by the listing's unique
 *   tie-break key, in the direction of the last key.
 * - A key with no direction is `asc`.
 * - Each field may appear once.
 * - No `sort`, or an empty list, gives the operation's default order. The two
 *   cannot be told apart on the wire, because an empty list writes no
 *   parameter.
 */
import { Schema, SchemaGetter } from "effect";

/** The page size a caller gets without asking. */
export const DEFAULT_PAGE_LIMIT = 50;

/** The largest page anyone may ask for. */
export const MAX_PAGE_LIMIT = 500;

export const SortDirection = Schema.Literals(["asc", "desc"]);

export type SortDirection = Schema.Schema.Type<typeof SortDirection>;

/**
 * One key of a `sort` list, as a caller sends it: the field to sort by and,
 * optionally, the direction. A key with no direction is `asc`.
 */
export interface SortKey<Field extends string = string> {
  readonly field: Field;
  readonly direction?: SortDirection;
}

/** The annotation carrying an operation's sortable fields; `readSortFields` reads it. */
const SORT_FIELDS = "sortFields";

/**
 * Checks that no field appears twice in a `sort` list, and fails with a
 * message naming the first field that does.
 *
 * A second key on the same field could never order anything, because the rows
 * it would order are already equal on that field. Refusing it tells the caller
 * about the mistake instead of ignoring the key.
 */
export const refuseRepeatedSortField = Schema.makeFilter(
  (keys: ReadonlyArray<{ readonly field: string }>) => {
    const seen = new Set<string>();
    for (const { field } of keys) {
      if (seen.has(field)) return `${field} appears more than once in sort; name each field once.`;
      seen.add(field);
    }
    return undefined;
  },
);

/**
 * Returns the codec of one sort key, `<field>[:<asc|desc>]` on the wire, over
 * one operation's own enum of sortable fields.
 */
const sortKeyParam = <const Fields extends ReadonlyArray<string>>(fields: Fields) => {
  const key = Schema.Struct({
    field: Schema.Literals(fields),
    direction: Schema.optionalKey(SortDirection),
  });
  type Key = typeof key.Encoded;
  return Schema.String.pipe(
    Schema.decodeTo(key, {
      // The split does not validate on purpose: its result is decoded by the
      // struct above, which turns an unknown field or direction into an issue
      // that points at that half of the parameter.
      decode: SchemaGetter.transform((text: string): Key => {
        const colon = text.indexOf(":");
        return (
          colon === -1
            ? { field: text }
            : { field: text.slice(0, colon), direction: text.slice(colon + 1) }
        ) as Key;
      }),
      encode: SchemaGetter.transform((value) =>
        value.direction === undefined ? value.field : `${value.field}:${value.direction}`,
      ),
    }),
  );
};

/**
 * Returns one operation's `sort` parameter: an ordered list of keys over that
 * operation's own enum of sortable fields, each key `<field>[:<asc|desc>]` on
 * the wire.
 *
 * The list holds at most one key per field, because every caller-controlled
 * list has a maximum. Any longer list must repeat a field, so the repeat check
 * runs first and its message, which names the field, is the one a caller sees.
 */
export const sortParam = <const Fields extends ReadonlyArray<string>>(fields: Fields) =>
  // The annotation goes on before the checks: annotating a schema that already
  // has checks annotates its last check, where `readSortFields` does not look.
  Schema.Array(sortKeyParam(fields))
    .annotate({ [SORT_FIELDS]: fields })
    .check(refuseRepeatedSortField, Schema.isMaxLength(fields.length));

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
