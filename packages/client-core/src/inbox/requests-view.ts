/**
 * How the user looks at the Requests column: which requests to show, whether
 * to group them, and in which order the rows of a group come. None of the
 * three moves a card: grouping decides the group a card is first placed in
 * (see `placeInboxCards`), and Show and Sort only narrow and order what is
 * already placed.
 */

/**
 * Which requests the column shows. A person is the displayed name of the
 * card's `person`: the contract has no person id, so the name is a label to
 * match on, not an identity.
 */
export type RequestsShow =
  | { readonly kind: "all" }
  | { readonly kind: "mine" }
  | { readonly kind: "person"; readonly name: string };

/** Whether the column draws one list or one group for each place. */
export type RequestsGrouping = "none" | "place";

/** The order of the rows inside a group: first to join the visit first, or last to join first. */
export type RequestsSort = "oldest" | "newest";

/** Show everything. The default of `RequestsShow`. */
export const SHOW_ALL: RequestsShow = { kind: "all" };

/** The three choices together, as `describeRequestsView` reads them. */
export interface RequestsView {
  readonly show: RequestsShow;
  readonly grouping: RequestsGrouping;
  readonly sort: RequestsSort;
}

/**
 * Returns the words for the choices of `view` that are not the default, in
 * the order Show, Group, Sort and joined by " · " ("Mine · By place"), or
 * `undefined` when all three are the default. The words are not shortened:
 * a long person's name is cut to the width of the control by its styling.
 */
export const describeRequestsView = (view: RequestsView): string | undefined => {
  const parts: string[] = [];
  if (view.show.kind === "mine") parts.push("Mine");
  else if (view.show.kind === "person") parts.push(view.show.name);
  if (view.grouping === "place") parts.push("By place");
  if (view.sort === "newest") parts.push("Newest first");
  return parts.length === 0 ? undefined : parts.join(" · ");
};
