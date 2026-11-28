import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  MERGE_PICK_WORDS,
  type MergeCheckResult,
  type MergeDecision,
  type WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { keepCardInView } from "./keep-in-view";
import { createMergeIntent, type MergeIntent } from "./merge-intent";

/**
 * How long, in milliseconds, the walk must rest on a card before the merge
 * check is asked, so stepping over many cards with the arrows asks only about
 * the one the walk stops on.
 */
const WALK_REST_MS = 150;

/** What `useMergePick` returns. */
export interface MergePick {
  /** The id of the card that is being merged into another, or `null` when none is picked. */
  readonly sourceId: string | null;
  /**
   * Starts picking the card to merge `card` into, by key or from the details.
   * The card gets a dashed outline, the keyboard focus goes to it, and the undo
   * line says what to do. The arrows then walk to the other cards.
   */
  readonly start: (card: WorkCard) => void;
  /** Stops picking, and changes nothing. */
  readonly cancel: () => void;
  /**
   * Merges the picked card into the card `targetCardId` and stops picking.
   * Choosing the picked card itself stops picking and merges nothing. So does
   * a target the merge check showed the controller would refuse: the undo line
   * says why instead.
   *
   * While the check has not answered, the pick stays on the card, showing
   * "Checking", and the merge follows the answer (see `MergeIntent.commit`).
   * Moving to another card or cancelling drops the wait.
   */
  readonly confirm: (targetCardId: string) => void;
}

/**
 * Holds the key flow of a merge: pick the card to merge, walk to the card to
 * merge it into with the arrows, Return to confirm, Esc to cancel. The walk is
 * the board's (`useBoardKeys`); this hook only marks the cards. While a card
 * is picked, the desk is marked `data-merge-picking` and the picked card
 * `data-merge-source`, and the card with the keyboard focus takes the same
 * marks as the card a drag chooses (`markMergeTarget`): its label says whom it
 * is merged into and what stays. All marks are data attributes set outside
 * React.
 *
 * Each card the walk rests on is chosen as the target of a merge intent
 * (`merge-intent.ts`), which checks it with `checkMerge` (the controller
 * answers whether the merge would be refused) and decides the merge. Until the
 * check answers, the card promises nothing; a refusal shows on the card in
 * place of its label.
 *
 * Picking ends by itself when the picked card leaves the board. The caller
 * cancels it when a card is put in the hand.
 *
 * - `cards` are the cards the board draws.
 * - `initiatives` are the open Initiatives, to name the one a merge keeps.
 * - `merge` settles the merge of one card into another as the intent decided
 *   (see `MergeCards.mergeCard`); it also says a refusal on the undo line.
 * - `checkMerge` asks whether a merge would be refused; it never rejects.
 * - `say` shows a line on the undo line with no Undo.
 * - `onStart` runs when picking starts, such as to close the details.
 */
export const useMergePick = ({
  scrollRef,
  cards,
  initiatives,
  merge,
  checkMerge,
  say,
  onStart,
}: {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly cards: readonly WorkCard[];
  readonly initiatives: readonly WorkInitiative[];
  readonly merge: (sourceCardId: string, targetCardId: string, decision: MergeDecision) => void;
  readonly checkMerge: (sourceCardId: string, targetCardId: string) => Promise<MergeCheckResult>;
  readonly say: (text: string) => void;
  readonly onStart: () => void;
}): MergePick => {
  const [pickedId, setPickedId] = useState<string | null>(null);
  // False from the moment picking ends, before React has drawn that, so a focus change in between marks nothing.
  const isPicking = useRef(false);
  const latest = useRef({ cards, initiatives, checkMerge });
  useLayoutEffect(() => {
    latest.current = { cards, initiatives, checkMerge };
  });
  /** The merge intent of the pick that is running: made when picking starts, and gone when it ends. */
  const intentRef = useRef<MergeIntent | null>(null);

  // A picked card that leaves the board (merged by another client, done, deleted) ends the picking.
  const sourceId = cards.some((card) => card.id === pickedId) ? pickedId : null;

  // A card that React replaced is a new element without the mark, so the mark is set again after every render.
  useLayoutEffect(() => {
    if (sourceId === null) return;
    const source = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${sourceId}"]`);
    if (source != null) source.dataset["mergeSource"] = "";
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    const desk = scroller?.closest<HTMLElement>(".work-desk");
    if (sourceId === null || scroller == null || desk == null) return;
    desk.dataset["mergePicking"] = "";
    const intent = createMergeIntent({
      readCards: () => latest.current.cards,
      readInitiatives: () => latest.current.initiatives,
      askCheck: (sourceCardId, targetCardId) =>
        latest.current.checkMerge(sourceCardId, targetCardId),
      // The check asks once the walk has rested on a card, so stepping over many cards asks only about the last.
      askAfterMs: WALK_REST_MS,
    });
    intentRef.current = intent;
    let marked: HTMLElement | null = null;
    const unmark = (): void => {
      marked = null;
      intent.leave();
    };
    const markFocused = (): void => {
      if (!isPicking.current) return;
      const focused = document.activeElement;
      const cardId = focused instanceof HTMLElement ? focused.dataset["cardId"] : undefined;
      const next =
        focused instanceof HTMLElement && scroller.contains(focused) && cardId !== sourceId
          ? focused
          : null;
      if (next === marked) return;
      unmark();
      if (next !== null && cardId !== undefined) {
        if (intent.choose({ sourceId, targetId: cardId, element: next })) marked = next;
      }
    };
    const onFocusOut = (event: FocusEvent): void => {
      const to = event.relatedTarget;
      if (!(to instanceof HTMLElement) || to.dataset["cardId"] === undefined) unmark();
    };
    scroller.addEventListener("focusin", markFocused);
    scroller.addEventListener("focusout", onFocusOut);
    markFocused();
    return () => {
      scroller.removeEventListener("focusin", markFocused);
      scroller.removeEventListener("focusout", onFocusOut);
      unmark();
      intentRef.current = null;
      delete desk.dataset["mergePicking"];
      for (const source of scroller.querySelectorAll<HTMLElement>("[data-merge-source]")) {
        delete source.dataset["mergeSource"];
      }
    };
  }, [sourceId, scrollRef]);

  /** Ends the pick on the card `targetCardId` with the merge `decision`: merges, or says why not. */
  const finish = (pickedSourceId: string, targetCardId: string, decision: MergeDecision): void => {
    isPicking.current = false;
    setPickedId(null);
    // The target gives up its marks first, so its settle after the merge is not cut short.
    intentRef.current?.leave();
    merge(pickedSourceId, targetCardId, decision);
    if (decision.kind === "refused") return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-card-id="${targetCardId}"]`)
      ?.focus({ preventScroll: true });
  };

  return {
    sourceId,
    start: (card) => {
      onStart();
      isPicking.current = true;
      setPickedId(card.id);
      say(MERGE_PICK_WORDS);
      const scroller = scrollRef.current;
      const element = scroller?.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
      if (scroller != null && element != null) {
        element.focus({ preventScroll: true });
        keepCardInView(scroller, element);
      }
    },
    cancel: () => {
      isPicking.current = false;
      intentRef.current?.leave();
      setPickedId(null);
    },
    confirm: (targetCardId) => {
      const intent = intentRef.current;
      if (sourceId === null || intent === null || intent.isWaiting()) return;
      if (targetCardId === sourceId) {
        isPicking.current = false;
        setPickedId(null);
        return;
      }
      // A card chosen with the pointer has not been walked to, so it is chosen here, with no marks.
      if (!intent.choose({ sourceId, targetId: targetCardId })) {
        // The card left the board: the merge says so.
        finish(sourceId, targetCardId, { kind: "unchecked" });
        return;
      }
      intent.commit({ onDecision: (decision) => finish(sourceId, targetCardId, decision) });
    },
  };
};
