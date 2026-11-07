/**
 * What both pages of the Overview (Work and Inbox) work out themselves: the
 * toolbar's filter and the age a card shows. It is the subpath `@hercule/client-core/desk`, not part of
 * the library's index, so that its code stays out of the shell's chunk.
 */
export * from "./age";
export * from "./filter";
