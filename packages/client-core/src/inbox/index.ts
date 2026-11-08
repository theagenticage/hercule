/**
 * What the Inbox works out from the read it holds: what a generic card draws,
 * its wait, where each card lies on the page, and the page itself with its
 * Group by and Filter menus. It is the subpath `@hercule/client-core/inbox`,
 * not part of the library's index, so that its code stays out of the shell's
 * chunk. The filter itself is in `@hercule/client-core/desk`, and so are the
 * rows that draw the places above a card.
 * The open card's words and a place's view are here too.
 *
 * Nothing here knows a kind by name: a plugin's card draws from its record.
 */
export * from "./card-aloud";
export * from "./card-bundles";
export * from "./card-face";
export * from "./card-hand-off";
export * from "./card-links";
export * from "./card-wait";
export * from "./empty-inbox";
export * from "./facets";
export * from "./groupings";
export * from "./inbox-notes";
export * from "./landed-signals";
export * from "./link-search";
export * from "./open-card";
export * from "./open-timeline";
export * from "./place-view";
export { HOME_GROUPING, STATUS_GROUPING, type SurfaceHead } from "./inbox-place";
export * from "./lay-out";
export type { RequestsOrder, RidingMove, VisitPlacement } from "./visit-placement";
export * from "./inbox-visit";
export { isMarkShownByHead, listSurfaceAboveWords, nameSurface } from "./surface-words";
export * from "./card-moves";
export * from "./inbox-walk";
