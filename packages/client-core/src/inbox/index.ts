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
export * from "./card-face";
export * from "./card-hand-off";
export * from "./card-wait";
export * from "./inbox-list";
export * from "./inbox-notes";
export * from "./open-card";
export * from "./open-timeline";
export * from "./place-view";
export * from "./card-moves";
export * from "./inbox-search";
