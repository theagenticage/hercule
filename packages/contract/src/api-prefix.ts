/**
 * The prefix every route of the public API carries.
 *
 * It lives in a module of its own, apart from the operation table, so that
 * `api.ts` can read it without taking in the table. The table ends in code a
 * bundler cannot prove has no side effects, so any bundle that imports
 * anything from `operations.ts` includes the whole table, about 3 kB gzipped.
 * The web app's first paint needs the prefix and not the table.
 */
export const API_PREFIX = "/api/v1";
