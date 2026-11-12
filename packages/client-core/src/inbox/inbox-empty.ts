/**
 * Which empty state the Inbox shows when its list holds nothing. The desktop
 * draws each case; this module only decides which one applies.
 */
import type { InboxCounts } from "@hercule/contract";

/** What decides the empty state. */
export interface InboxEmptyFacts {
  /** True when a clause or free text narrows the list. */
  readonly isSearching: boolean;
  /** The saved query the list is on, or `null` for a Browse value. */
  readonly savedQueryId: string | null;
  readonly counts: Pick<InboxCounts, "savedQueries">;
}

/**
 * - `nothing-matches`: a search found nothing in its scope.
 * - `all-clear`: nobody waits and the Inbox holds nothing at all (the list is
 *   the waits list and Everything counts none).
 * - `nobody-waits`: the waits list is empty, and `updatesCount` things changed without asking.
 * - `nothing-in-list`: any other list holds nothing.
 */
export type InboxEmptyCase =
  | { readonly kind: "nothing-matches" }
  | { readonly kind: "all-clear" }
  | { readonly kind: "nobody-waits"; readonly updatesCount: number }
  | { readonly kind: "nothing-in-list" };

/** Returns the empty state for a list that holds no rows. */
export const decideInboxEmpty = ({
  isSearching,
  savedQueryId,
  counts,
}: InboxEmptyFacts): InboxEmptyCase => {
  if (isSearching) return { kind: "nothing-matches" };
  if (savedQueryId !== "waits") return { kind: "nothing-in-list" };
  const countOf = (id: string): number =>
    counts.savedQueries.find((query) => query.id === id)?.count ?? 0;
  if (countOf("everything") === 0) return { kind: "all-clear" };
  return { kind: "nobody-waits", updatesCount: countOf("updates") };
};
