import {
  describeMergeNote,
  describeMergeTarget,
  type MergeCheckResult,
  type MergeCheckState,
} from "@hercule/client-core/work";
import { trackBody } from "../../app/motion";

/** How much bigger the card that is merged into is while it is picked. */
const MERGE_TARGET_SCALE = 1.02;

/**
 * How long, in milliseconds, a confirm waits for a merge check that has not
 * answered. After that the merge goes ahead unchecked and the controller's
 * merge decides.
 */
export const MERGE_CHECK_WAIT_MS = 2000;

/** What the labels on the card to merge into say. */
export interface MergeTargetWords {
  /** The title of the card merged into. */
  readonly title: string;
  /** What stays after the merge (`describeMergeKeeps`), shown once the check allows it. */
  readonly keeps: string;
  /** What the merge check found so far. */
  readonly check: MergeCheckState;
}

/**
 * Writes the labels of a merge target onto `card` as data attributes: the
 * check's state, the label on the top edge, and the note on the bottom edge
 * (absent while the check runs). Safe to call again when the check answers.
 */
export const showMergeTargetWords = (card: HTMLElement, words: MergeTargetWords): void => {
  card.dataset["mergeCheck"] = words.check.kind;
  card.dataset["mergeLabel"] = describeMergeTarget(words.title, words.check);
  const note = describeMergeNote(words.check, words.keeps);
  if (note === undefined) delete card.dataset["mergeKeeps"];
  else card.dataset["mergeKeeps"] = note;
};

/**
 * Marks `card`, the element of a card on the board, as the one a merge goes
 * into: it swells on `hand`, takes a ring, and shows a label on its top edge
 * ("Merge into Serve smaller…", or the refusal) and one on its bottom edge
 * (what stays, "Keeps its title, stage and place"). The marks are data
 * attributes and a scale outside React, which never rewrites them.
 */
export const markMergeTarget = (card: HTMLElement, words: MergeTargetWords): void => {
  card.dataset["mergeTarget"] = "";
  showMergeTargetWords(card, words);
  trackBody(card).to({ s: MERGE_TARGET_SCALE }, "hand");
};

/** Takes the marks of `markMergeTarget` off `card`, and lets it settle back to its size on `hand`. */
export const unmarkMergeTarget = (card: HTMLElement): void => {
  delete card.dataset["mergeTarget"];
  delete card.dataset["mergeCheck"];
  delete card.dataset["mergeLabel"];
  delete card.dataset["mergeKeeps"];
  const body = trackBody(card);
  body.to({ s: 1 }, "hand", {
    done: () => {
      body.clear();
    },
  });
};

/** A merge check running for the card chosen as the target (see `startMergeTargetCheck`). */
export interface MergeTargetCheck {
  /** Returns what the check found so far: `checking` until the controller answers. */
  readonly read: () => MergeCheckState;
  /** Settles with the controller's answer, whether or not the target is still chosen by then. Never rejects. */
  readonly result: Promise<MergeCheckResult>;
  /** Asks now, when the ask was held back for `askAfterMs`. Does nothing once asked. */
  readonly askNow: () => void;
  /** Stops a held-back ask that has not started. Does nothing once asked. */
  readonly stop: () => void;
}

/**
 * Marks `element` as the card a merge goes into, shows it as `checking`, asks
 * the controller with `ask`, and shows the answer on the card as long as
 * `isCurrent()` is still true when it arrives (a card left or chosen again
 * makes it stale). The ask starts `askAfterMs` from now, or at once with `0`;
 * `askNow` and `stop` act on the wait.
 *
 * The answer is never shown as approval before it arrives: the card says
 * `checking` until then.
 */
export const startMergeTargetCheck = ({
  element,
  title,
  keeps,
  ask,
  askAfterMs,
  isCurrent,
}: {
  readonly element: HTMLElement;
  readonly title: string;
  readonly keeps: string;
  readonly ask: () => Promise<MergeCheckResult>;
  readonly askAfterMs: number;
  readonly isCurrent: () => boolean;
}): MergeTargetCheck => {
  let state: MergeCheckState = { kind: "checking" };
  markMergeTarget(element, { title, keeps, check: state });
  let isAsked = false;
  let timer: number | undefined;
  let askNow: () => void = () => undefined;
  const result = new Promise<MergeCheckResult>((resolve) => {
    askNow = () => {
      if (isAsked) return;
      isAsked = true;
      window.clearTimeout(timer);
      void ask().then((answer) => {
        resolve(answer);
        if (!isCurrent()) return;
        state = answer;
        showMergeTargetWords(element, { title, keeps, check: answer });
      });
    };
  });
  if (askAfterMs <= 0) askNow();
  else timer = window.setTimeout(askNow, askAfterMs);
  return {
    read: () => state,
    result,
    askNow,
    stop: () => {
      window.clearTimeout(timer);
    },
  };
};

/**
 * Returns the answer of `result`, or `unchecked` when none arrives within
 * `MERGE_CHECK_WAIT_MS`. A timeout is not an approval: the merge that goes
 * ahead is decided by the controller.
 */
export const waitForMergeCheck = (result: Promise<MergeCheckResult>): Promise<MergeCheckResult> =>
  new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      resolve({ kind: "unchecked" });
    }, MERGE_CHECK_WAIT_MS);
    void result.then((answer) => {
      window.clearTimeout(timer);
      resolve(answer);
    });
  });
