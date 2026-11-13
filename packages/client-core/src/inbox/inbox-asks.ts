/**
 * Which asks the Inbox pane shows as sections, and which answers are held
 * before they are sent. Pure rules over the pane's read: no kind is named
 * here. Which ask is current is in `inbox-ask-choice.ts`.
 */
import { isQualifiedId, type BoundAction, type EntitySignalLine } from "@hercule/contract";

/** The asks the pane draws as sections, and how many open signals its read left out. */
export interface PaneAsks {
  /** Newest first: the open, unsnoozed signals whose kind asks the user for a move. */
  readonly sections: readonly EntitySignalLine[];
  /**
   * How many open signals the read holds that the pane has no line for, because
   * the read lists at most `MAX_ENTITY_SIGNALS` lines. Some of them may be
   * snoozed or may not ask, so the pane words it as "N more", never as a
   * promise that each is an ask.
   */
  readonly hiddenOpenCount: number;
}

/** Orders signal lines newest first by `createdAt`; lines raised at the same moment go by id, larger first. */
const compareNewestFirst = (a: EntitySignalLine, b: EntitySignalLine): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Returns the sections of the pane for the signal lines of an entity read.
 * `openCount` is the read's count of every open signal. The read lists open
 * signals before resolved ones, so the open lines it left out are
 * `openCount` minus the open lines listed.
 */
export const listPaneAsks = (read: {
  readonly signals: readonly EntitySignalLine[];
  readonly openCount: number;
}): PaneAsks => {
  const open = read.signals.filter((line) => line.status === "open");
  return {
    sections: open.filter((line) => line.asks && !line.snoozed).toSorted(compareNewestFirst),
    hiddenOpenCount: Math.max(0, read.openCount - open.length),
  };
};

/** How long an answer that acts on the source waits before it is sent, in milliseconds. */
export const SIGNAL_ANSWER_HOLD_MS = 8_000;

/**
 * Checks whether `action` is held for `SIGNAL_ANSWER_HOLD_MS` before it is
 * sent: it is when it runs a plugin's operation, which acts on the source.
 * Done and the core's own operations are not held.
 *
 * This rule is conservative: a plugin's operation may change nothing at the
 * source, and every one is held all the same, because the core cannot tell.
 */
export const isAnswerHeld = (action: Pick<BoundAction, "operation">): boolean =>
  action.operation !== null && isQualifiedId(action.operation.op);
