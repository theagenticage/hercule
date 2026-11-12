/**
 * What the Inbox list is on, and the query it reads for it. The scope is the
 * rail's entry: a saved query, or a Browse value. The search narrows it.
 * The scope lives in the URL's search params, so a reload, a link and the
 * Back button keep the list the user was on.
 */
import type { InboxScope, InboxSearch } from "@hercule/client-core/inbox";

/** What of the search narrows the list: its clauses and its free text, not what is half typed. */
export type InboxNarrowing = Pick<InboxSearch, "clauses" | "text">;
import { CORE_SAVED_QUERY_IDS, MAX_INBOX_TEXT_LENGTH, type InboxList } from "@hercule/contract";
import type { InboxSelection } from "../../../app/queries";

/** The id of the saved query the Inbox opens on: the things someone waits on the user for. */
export const DEFAULT_INBOX_QUERY_ID = CORE_SAVED_QUERY_IDS.waits;

/** The scope the Inbox opens on. */
export const DEFAULT_INBOX_SCOPE: InboxScope = { kind: "saved-query", id: DEFAULT_INBOX_QUERY_ID };

/** The id of the saved query that holds everything, which the search widens to. */
export const EVERYTHING_QUERY_ID = CORE_SAVED_QUERY_IDS.everything;

/** The scope a search widens to. */
export const EVERYTHING_INBOX_SCOPE: InboxScope = { kind: "saved-query", id: EVERYTHING_QUERY_ID };

/** Returns the list a scope reads: a saved query by its id, or the one clause a Browse value sends. */
export const buildInboxList = (scope: InboxScope): InboxList =>
  scope.kind === "saved-query" ? { savedQuery: scope.id } : { browse: scope.value };

/** Returns the selection of a scope and the search over it: what a list shows. */
export const buildInboxSelection = (scope: InboxScope, search: InboxNarrowing): InboxSelection => ({
  list: buildInboxList(scope),
  clauses: [...search.clauses],
  text: search.text,
});

/** Returns whether the search narrows the scope at all. */
export const isSearching = (search: InboxNarrowing): boolean =>
  search.clauses.length > 0 || search.text.trim() !== "";

/**
 * The search params that hold the scope:
 *
 * - `list`: the id of a saved query. With none of the params below, the Inbox opens on the waits list.
 * - `source`, `key` and `value`: a Browse value, together. They win over `list`.
 * - `account`: the connection the Browse value is read in, when its source has several.
 *
 * A param may be `undefined` in a search a caller builds, which removes it from the URL.
 */
export interface InboxScopeParams {
  readonly list?: string | undefined;
  readonly source?: string | undefined;
  readonly key?: string | undefined;
  readonly value?: string | undefined;
  readonly account?: string | undefined;
}

/** Checks whether `value` is a non-empty string of at most `MAX_INBOX_TEXT_LENGTH` characters. */
const isBoundedText = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_INBOX_TEXT_LENGTH;

/**
 * Returns the scope params from the URL's. A param that is not a short
 * non-empty string is dropped, and the Browse value params are kept only when
 * all three of them are there. A dropped param is returned as `undefined`
 * rather than left out, because the router lays the returned params over the
 * URL's: a param left out would keep the URL's value.
 */
export const validateInboxScopeParams = (search: Record<string, unknown>): InboxScopeParams => {
  const hasValue =
    isBoundedText(search["source"]) &&
    isBoundedText(search["key"]) &&
    isBoundedText(search["value"]);
  return {
    list: isBoundedText(search["list"]) ? search["list"] : undefined,
    source: hasValue ? (search["source"] as string) : undefined,
    key: hasValue ? (search["key"] as string) : undefined,
    value: hasValue ? (search["value"] as string) : undefined,
    account: hasValue && isBoundedText(search["account"]) ? search["account"] : undefined,
  };
};

/** Returns the scope the params name: a Browse value when they hold one, else a saved query, else the waits list. */
export const readInboxScope = ({
  list,
  source,
  key,
  value,
  account,
}: InboxScopeParams): InboxScope =>
  source !== undefined && key !== undefined && value !== undefined
    ? {
        kind: "value",
        value: { source, key, value, ...(account === undefined ? {} : { connectionId: account }) },
      }
    : { kind: "saved-query", id: list ?? DEFAULT_INBOX_QUERY_ID };

/**
 * Returns the params that name `scope`. The waits list, which the Inbox
 * opens on, has none, so its URL stays plain.
 */
export const buildInboxScopeParams = (scope: InboxScope): InboxScopeParams => {
  if (scope.kind === "saved-query") {
    return { list: scope.id === DEFAULT_INBOX_QUERY_ID ? undefined : scope.id };
  }
  const { source, key, value, connectionId } = scope.value;
  return { source, key, value, account: connectionId };
};
