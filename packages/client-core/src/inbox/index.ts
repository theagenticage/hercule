/**
 * What the Inbox works out from the read it holds: what a generic card draws,
 * its wait, the list that holds still, the search field, and the open card's
 * words. It is the subpath `@hercule/client-core/inbox`, not part of the
 * library's index, so that its code stays out of the shell's chunk.
 *
 * Nothing here knows a kind by name: a plugin's card draws from its record.
 */
export * from "./card-face";
export * from "./card-hand-off";
export * from "./card-wait";
export * from "./inbox-empty";
export * from "./inbox-holder";
export * from "./inbox-visit";
export * from "./inbox-row";
export * from "./inbox-group-row";
export * from "./inbox-search";
export * from "./inbox-moves";
export * from "./thread-start";
export * from "./inbox-outline";
export * from "./inbox-asks";
export * from "./inbox-ask-choice";
export * from "./inbox-pane-words";
export * from "./inbox-pane-view";
export * from "./inbox-group-pane-view";
export * from "./inbox-link-candidates";
export * from "./inbox-current";
