/**
 * What the Work board works out from the cards it has read: the lanes, what a
 * cell shows, a move before the controller answers, the Filter menu's facets,
 * Find, the keyboard walk and the words on a card. It is the subpath
 * `@hercule/client-core/work`, not part of the library's index, so that its
 * code stays out of the shell's chunk. The filter itself is in
 * `@hercule/client-core/desk`.
 */
export * from "./arrange-cell";
export * from "./board-key";
export * from "./card-move";
export * from "./card-words";
export * from "./facets";
export * from "./find";
export * from "./lane-summary";
export * from "./lanes";
export * from "./walk";
