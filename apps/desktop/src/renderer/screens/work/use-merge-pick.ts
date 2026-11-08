import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  describeMergeKeeps,
  describeMergeRefused,
  MERGE_PICK_WORDS,
  type MergeCheckResult,
  type MergeCheckState,
  type WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { keepCardInView } from "./keep-in-view";
import { markMergeTarget, showMergeTargetWords, unmarkMergeTarget } from "./merge-target";

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
 * Each card the walk reaches is checked with `checkMerge` (the controller
 * answers whether the merge would be refused). Until it answers, the card
 * promises nothing; a refusal shows on the card in place of its label.
 *
 * Picking ends by itself when the picked card leaves the board. The caller
 * cancels it when a card is put in the hand.
 *
 * - `cards` are the cards the board draws.
 * - `initiatives` are the open Initiatives, to name the one a merge keeps.
 * - `merge` merges one card into another (see `MergeCards.mergeCard`).
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
  readonly merge: (sourceCardId: string, targetCardId: string) => void;
  readonly checkMerge: (sourceCardId: string, targetCardId: string) => Promise<MergeCheckResult>;
  readonly say: (text: string) => void;
  readonly onStart: () => void;
}): MergePick => {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const unmarkTarget = useRef<() => void>(() => undefined);
  // False from the moment picking ends, before React has drawn that, so a focus change in between marks nothing.
  const isPicking = useRef(false);
  const latest = useRef({ cards, initiatives, checkMerge });
  useLayoutEffect(() => {
    latest.current = { cards, initiatives, checkMerge };
  });
  /** The card the walk is on, and what the merge check found for it. `null` when the walk is on no card. */
  const checked = useRef<{ cardId: string; check: MergeCheckState } | null>(null);

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
    let marked: HTMLElement | null = null;
    const unmark = (): void => {
      if (marked !== null) unmarkMergeTarget(marked);
      marked = null;
      checked.current = null;
    };
    unmarkTarget.current = unmark;
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
      const { cards: current, initiatives: open, checkMerge: check } = latest.current;
      const target = current.find((card) => card.id === cardId);
      if (next !== null && target !== undefined) {
        const words = {
          title: target.title,
          keeps: describeMergeKeeps(
            target,
            current.find((card) => card.id === sourceId) ?? {},
            open,
          ),
        };
        const walk = { cardId: target.id, check: { kind: "checking" } as MergeCheckState };
        markMergeTarget(next, { ...words, check: walk.check });
        marked = next;
        checked.current = walk;
        // The answer counts only while the walk is still on this card.
        void check(sourceId, target.id).then((result) => {
          if (checked.current !== walk) return;
          walk.check = result;
          showMergeTargetWords(next, { ...words, check: result });
        });
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
      unmarkTarget.current = () => undefined;
      delete desk.dataset["mergePicking"];
      for (const source of scroller.querySelectorAll<HTMLElement>("[data-merge-source]")) {
        delete source.dataset["mergeSource"];
      }
    };
  }, [sourceId, scrollRef]);

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
      setPickedId(null);
    },
    confirm: (targetCardId) => {
      if (sourceId === null) return;
      isPicking.current = false;
      setPickedId(null);
      if (targetCardId === sourceId) return;
      const check = checked.current?.cardId === targetCardId ? checked.current.check : undefined;
      // The target gives up its marks first, so its settle after the merge is not cut short.
      unmarkTarget.current();
      if (check?.kind === "refused") {
        const title =
          latest.current.cards.find((card) => card.id === sourceId)?.title ?? "The card";
        say(describeMergeRefused(title, check.refusal));
        return;
      }
      merge(sourceId, targetCardId);
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-card-id="${targetCardId}"]`)
        ?.focus({ preventScroll: true });
    },
  };
};
