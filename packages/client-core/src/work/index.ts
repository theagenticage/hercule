/**
 * What the Work board works out from the cards it has read: the lanes, what a
 * cell shows, a move before the controller answers and the drop that asks for
 * it, the Filter menu's facets, Find, the changes the board holds back until
 * the user's hand is still, the keyboard walk, which cards are selected, and the words and the pose of a
 * card. It is the subpath `@hercule/client-core/work`, not part of the
 * library's index, so that its code stays out of the shell's chunk. The
 * filter itself is in `@hercule/client-core/desk`.
 */
export * from "./arrange-cell";
export * from "./arrange-lanes";
export * from "./card-change";
export * from "./card-move";
export * from "./card-pose";
export * from "./card-words";
export * from "./describe-card-move";
export * from "./drop-move";
export * from "./facets";
export * from "./find";
export * from "./held-answers";
export * from "./hold-back-board";
export * from "./lanes";
export * from "./logical-board";
export * from "./merge";
export * from "./question-answers";
export * from "./selection";
export * from "./summary-standing";
export * from "./task-pane";
export * from "./task-run";
export * from "./task-thread";
export * from "./thread-changes";
export * from "./try-again";
export * from "./walk";
