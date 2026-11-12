/**
 * The saved queries of the Inbox: the named lists of its rail. The core owns
 * five, which exist whatever plugins are loaded. Each plugin may add some,
 * which come after the core's, in the order the plugins loaded.
 *
 * A saved query is code, not a stored record. Its id is its identity: a core
 * query has a plain id (`waits`), a plugin's is qualified with the plugin's id
 * (`github/review-requests`).
 */
import * as Effect from "effect/Effect";
import { CORE_SAVED_QUERY_IDS, createValidationError, type Validation } from "@hercule/contract";
import type { RegisteredSavedQuery } from "../plugins";

/**
 * The core's saved queries, in the order the rail lists them.
 *
 * "Someone waits on me" has no `held` clause on purpose: a thing someone
 * waits on stays there while a Task holds it.
 */
export const CORE_SAVED_QUERIES: ReadonlyArray<RegisteredSavedQuery> = [
  {
    id: CORE_SAVED_QUERY_IDS.waits,
    name: "Someone waits on me",
    order: "waiting",
    clauses: [{ key: "asks", op: "is", value: true }],
  },
  {
    id: CORE_SAVED_QUERY_IDS.mine,
    name: "Mine",
    order: "newest",
    clauses: [{ key: "mine", op: "is", value: true }],
  },
  {
    id: CORE_SAVED_QUERY_IDS.updates,
    name: "Updates",
    order: "newest",
    clauses: [
      { key: "asks", op: "is", value: false },
      { key: "held", op: "is", value: false },
    ],
  },
  {
    id: CORE_SAVED_QUERY_IDS.held,
    name: "With Hercule",
    order: "newest",
    clauses: [{ key: "held", op: "is", value: true }],
  },
  { id: CORE_SAVED_QUERY_IDS.everything, name: "Everything", order: "newest", clauses: [] },
];

/**
 * Returns every saved query: the core's, then `pluginQueries` as given. The
 * caller passes the queries of the active plugins in load order.
 */
export const listSavedQueries = (
  pluginQueries: ReadonlyArray<RegisteredSavedQuery>,
): ReadonlyArray<RegisteredSavedQuery> => [...CORE_SAVED_QUERIES, ...pluginQueries];

/**
 * Returns the saved query with this id, or fails with `Validation` naming the
 * id and listing the ids that exist. A client holding an id of a query whose
 * plugin has since been disabled gets this error, and should show the list
 * again.
 */
export const findSavedQuery = (
  id: string,
  pluginQueries: ReadonlyArray<RegisteredSavedQuery>,
): Effect.Effect<RegisteredSavedQuery, Validation> => {
  const queries = listSavedQueries(pluginQueries);
  const found = queries.find((query) => query.id === id);
  return found === undefined
    ? Effect.fail(
        createValidationError(
          [
            {
              path: ["list", "savedQuery"],
              message: `there is no saved query "${id}". Choose one of: ${queries.map((query) => query.id).join(", ")}.`,
            },
          ],
          `unknown saved query "${id}"`,
        ),
      )
    : Effect.succeed(found);
};
