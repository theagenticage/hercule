/**
 * What both pages of the Overview (Work and Inbox) work out themselves: the
 * toolbar's filter, the age a card shows, and the rows that draw the outside
 * graph above a card. It is the subpath `@hercule/client-core/desk`, not part of
 * the library's index, so that its code stays out of the shell's chunk.
 */
export * from "./age";
export * from "./entity-words";
export * from "./filter";
export * from "./place-facets";
export * from "./relation-rows";
