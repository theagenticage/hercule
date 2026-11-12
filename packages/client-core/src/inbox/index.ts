/**
 * What the Inbox works out from the read it holds: what a generic card draws,
 * its wait, the list that holds still, the search field, and the open card's
 * words. It is the subpath `@hercule/client-core/inbox`, not part of the
 * library's index, so that its code stays out of the shell's chunk.
 *
 * Nothing here knows a kind by name: a plugin's card draws from its record.
 */
export * from "./card-aloud";
export * from "./card-face";
export * from "./card-hand-off";
export * from "./card-wait";
export * from "./inbox-empty";
export * from "./inbox-list";
export * from "./inbox-row";
export * from "./open-card";
export * from "./open-timeline";
export * from "./inbox-search";
