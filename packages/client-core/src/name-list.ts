/**
 * Formats a list of names the way a sentence lists them. Every list of names
 * a client shows goes through `formatNameList`, so they all read the same.
 */

const LIST_FORMATS = {
  and: new Intl.ListFormat("en", { type: "conjunction" }),
  or: new Intl.ListFormat("en", { type: "disjunction" }),
};

/**
 * Returns `names` as a reader would list them, joined with `conjunction`:
 * "A", "A and B", "A, B and C". A list of three or more gets no comma before
 * the conjunction, as the Crew Bureau book writes it. Returns "" for no names.
 */
export const formatNameList = (names: Iterable<string>, conjunction: "and" | "or"): string =>
  LIST_FORMATS[conjunction].format(names).replace(/, (and|or) /, " $1 ");
