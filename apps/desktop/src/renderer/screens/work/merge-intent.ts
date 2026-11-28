/**
 * The intent to merge one card of the Work board into another, from the first
 * time a card is chosen as the target to the moment the merge is decided.
 * Dragging a card over another and picking the target by key both go through
 * it. They only report what the user does (choose a target, leave it, let go
 * or confirm) and draw their own motion. This module decides when the merge
 * may go ahead, and with what: it asks the controller whether the merge would
 * be refused (`task.checkMerge`), shows the answer on the card, and turns the
 * answer into one `MergeDecision`.
 */
import {
  decideMerge,
  describeMergeKeeps,
  type MergeCheckResult,
  type MergeCheckState,
  type MergeDecision,
  type WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { markMergeTarget, showMergeTargetWords, unmarkMergeTarget } from "./merge-target";

/**
 * How long, in milliseconds, a commit waits for a merge check that has not
 * answered. After that the merge goes ahead unchecked and the controller's
 * merge decides.
 */
export const MERGE_CHECK_WAIT_MS = 2000;

/** The two cards of a merge: the card that merges away and the card it merges into. */
export interface MergePair {
  readonly sourceId: string;
  readonly targetId: string;
}

/** What the caller of `commit` gets back, and when. */
export interface MergeCommit {
  /**
   * Called once, with the decision, as soon as it is known: at once when the
   * check has answered, otherwise when it answers or after
   * `MERGE_CHECK_WAIT_MS`. The target keeps its marks until the caller calls
   * `leave`, so the caller can finish its own motion first.
   */
  readonly onDecision: (decision: MergeDecision, pair: MergePair) => void;
  /**
   * When given, a commit that is still waiting for the check is watched:
   * Esc, a window that loses the focus and a hidden window cancel the wait,
   * and this is called instead of `onDecision`. When omitted, the caller has
   * its own way to cancel and the wait is not watched.
   */
  readonly onCancel?: () => void;
}

/** What `createMergeIntent` needs from the screen. */
export interface MergeIntentOptions {
  /** Returns the cards the board draws now, to read the titles of the two cards. */
  readonly readCards: () => readonly WorkCard[];
  /** Returns the open Initiatives, to name the one a merge keeps. */
  readonly readInitiatives: () => readonly WorkInitiative[];
  /**
   * Asks the controller whether the merge would be refused. It never
   * rejects: a question that could not be asked answers `unchecked`.
   */
  readonly askCheck: (sourceId: string, targetId: string) => Promise<MergeCheckResult>;
  /**
   * How long, in milliseconds, a chosen target rests before the check is
   * asked, so stepping over many cards asks only about the one the walk stops
   * on. `0` asks at once. A commit asks at once whatever this is.
   */
  readonly askAfterMs: number;
}

/**
 * The merge intent. At most one target is chosen at a time. Its check is
 * asked, and shown on the target card as `checking` until it answers. An
 * answer that arrives after the target was left, chosen again, committed to
 * another decision or cancelled is stale and ignored.
 */
export interface MergeIntent {
  /**
   * Chooses `target` as the card `sourceId` merges into: marks `element`, the
   * element of the target (when given), with the labels of the merge and asks
   * the check. Leaves any earlier choice first; choosing the pair that is
   * already chosen changes nothing. Returns `false`, and chooses nothing, when
   * the target card is no longer on the board.
   */
  readonly choose: (choice: MergePair & { readonly element?: HTMLElement }) => boolean;
  /**
   * Drops the chosen target: its marks come off, a check not yet asked is not
   * asked, the answer of one asked is ignored, and a commit that waits is
   * dropped without a call. Safe to call again.
   */
  readonly leave: () => void;
  /** Returns whether a commit is waiting for the check. */
  readonly isWaiting: () => boolean;
  /**
   * Commits to the merge into the chosen target. Returns `false`, and does
   * nothing, when no target is chosen or a commit already waits. Otherwise
   * calls `onDecision` once, as described there, and returns `true`.
   *
   * A check that has not answered is waited for. The answer decides; no answer
   * within `MERGE_CHECK_WAIT_MS` decides `unchecked`, which is never an
   * approval.
   */
  readonly commit: (commit: MergeCommit) => boolean;
}

/** The target chosen now, and everything its check and its commit hold. */
interface Chosen {
  readonly pair: MergePair;
  /** The element that carries the marks, or `undefined` for a target with none. */
  readonly element: HTMLElement | undefined;
  readonly title: string;
  readonly keeps: string;
  /** What the check found so far. */
  check: MergeCheckState;
  isAsked: boolean;
  askTimer: number | undefined;
  /** Set from `commit` until the decision is made or the wait is cancelled. */
  waiting: Waiting | null;
}

/** A commit that is waiting for the check. */
interface Waiting {
  readonly commit: MergeCommit;
  timer: number | undefined;
  stopWatching: () => void;
}

/**
 * Listens for Esc, a window that loses the focus and a hidden window, and
 * calls `onAway` for each. Returns the function that stops listening.
 */
const watchForAway = (onAway: () => void): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onAway();
  };
  const onVisibilityChange = (): void => {
    if (document.hidden) onAway();
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onAway);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onAway);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
};

/** Creates a merge intent with nothing chosen. */
export const createMergeIntent = (options: MergeIntentOptions): MergeIntent => {
  /**
   * Counts the changes that make the answer of a check stale: a new choice,
   * leaving, a decision and a cancel. A check cannot be stopped once asked, so
   * its answer takes the number when it is asked and is ignored when the
   * number has moved on. Timers are cleared by the same changes.
   */
  let generation = 0;
  let chosen: Chosen | null = null;

  const showWords = (target: Chosen): void => {
    if (target.element === undefined) return;
    showMergeTargetWords(target.element, {
      title: target.title,
      keeps: target.keeps,
      check: target.check,
    });
  };

  /** Asks the check for `target` once. Its answer counts only while the generation is the one it was asked in. */
  const ask = (target: Chosen): void => {
    if (target.isAsked) return;
    target.isAsked = true;
    window.clearTimeout(target.askTimer);
    const startedAt = generation;
    void options.askCheck(target.pair.sourceId, target.pair.targetId).then((answer) => {
      if (generation !== startedAt) return;
      target.check = answer;
      // Once the commit waits, the target stays as the drop left it: the decision follows at once.
      if (target.waiting === null) showWords(target);
      else decide(target, answer);
    });
  };

  /** Stops the timer and the watching of a commit that waits. */
  const stopWaiting = (waiting: Waiting): void => {
    window.clearTimeout(waiting.timer);
    waiting.stopWatching();
  };

  /** Makes the decision for the commit that waits on `target`, from `check`. */
  const decide = (target: Chosen, check: MergeCheckResult): void => {
    const waiting = target.waiting;
    if (waiting === null) return;
    generation += 1;
    stopWaiting(waiting);
    target.waiting = null;
    const sourceTitle =
      options.readCards().find((card) => card.id === target.pair.sourceId)?.title ?? "The card";
    waiting.commit.onDecision(decideMerge(check, sourceTitle), target.pair);
  };

  /** Cancels the commit that waits on `target`, without a decision. */
  const cancelWait = (target: Chosen): void => {
    const waiting = target.waiting;
    if (waiting === null) return;
    generation += 1;
    stopWaiting(waiting);
    target.waiting = null;
    waiting.commit.onCancel?.();
  };

  const leave = (): void => {
    generation += 1;
    const target = chosen;
    chosen = null;
    if (target === null) return;
    window.clearTimeout(target.askTimer);
    if (target.waiting !== null) stopWaiting(target.waiting);
    target.waiting = null;
    if (target.element !== undefined) unmarkMergeTarget(target.element);
  };

  return {
    choose: ({ sourceId, targetId, element }) => {
      if (chosen?.pair.sourceId === sourceId && chosen.pair.targetId === targetId) return true;
      leave();
      const cards = options.readCards();
      const card = cards.find((each) => each.id === targetId);
      if (card === undefined) return false;
      const target: Chosen = {
        pair: { sourceId, targetId },
        element,
        title: card.title,
        keeps: describeMergeKeeps(
          card,
          cards.find((each) => each.id === sourceId) ?? {},
          options.readInitiatives(),
        ),
        check: { kind: "checking" },
        isAsked: false,
        askTimer: undefined,
        waiting: null,
      };
      chosen = target;
      if (element !== undefined) {
        markMergeTarget(element, { title: target.title, keeps: target.keeps, check: target.check });
      }
      if (options.askAfterMs <= 0) ask(target);
      else target.askTimer = window.setTimeout(() => ask(target), options.askAfterMs);
      return true;
    },
    leave,
    isWaiting: () => chosen !== null && chosen.waiting !== null,
    commit: (commit) => {
      const target = chosen;
      if (target === null || target.waiting !== null) return false;
      const waiting: Waiting = { commit, timer: undefined, stopWatching: () => undefined };
      target.waiting = waiting;
      if (target.check.kind !== "checking") {
        decide(target, target.check);
        return true;
      }
      ask(target);
      waiting.timer = window.setTimeout(() => {
        decide(target, { kind: "unchecked" });
      }, MERGE_CHECK_WAIT_MS);
      if (commit.onCancel !== undefined) {
        waiting.stopWatching = watchForAway(() => {
          cancelWait(target);
        });
      }
      return true;
    },
  };
};
