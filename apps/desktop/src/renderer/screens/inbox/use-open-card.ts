/**
 * What the Inbox keeps about its open card: which card or place the sheet is
 * on, where it opened from, and the way back through what was walked to inside
 * it. The sheet itself (`InboxOpenCard`) draws from this; the page's keys and
 * clicks drive it.
 */
import { useRef, useState } from "react";
import { findCardOrPlaceElement } from "./inbox-page-dom";

/**
 * What the sheet can be open on: a card of the Inbox, by its id, or a place,
 * by its ref. The two are kept apart because only a card has moves, and a ref
 * that the Inbox read does not hold must not be mistaken for a card.
 */
export type OpenTarget =
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "place"; readonly ref: string };

/** The open card, as the page's keys and clicks use it. */
export interface OpenCard {
  /** True from `open` until `close`, also while the sheet is open on a place. */
  readonly isOpen: boolean;
  /**
   * The card or place the sheet opened from, or `null` while nothing is open
   * (also while the sheet folds home). J and K step from it. Walking to a
   * place inside the sheet does not change it, because it is where the sheet
   * folds back to.
   */
  readonly origin: OpenTarget | null;
  /**
   * What the sheet shows now, or `null` while nothing is open. It differs from
   * `origin` after walking inside the sheet. The moves (T, E, G) act on this,
   * and only when it is a card.
   */
  readonly shown: OpenTarget | null;
  /**
   * Opens the sheet on `target`, from `originElement`, the element of the card
   * or place on the page. Called again while open, it moves the sheet to
   * `target` where it stands. Called while the sheet folds home, it turns
   * round.
   */
  readonly open: (target: OpenTarget, originElement: HTMLElement) => void;
  /** Folds the sheet back into the card it opened from. Does nothing when nothing is open. */
  readonly close: () => void;
  /**
   * Folds the sheet back like `close`, then calls `then` once it has landed
   * (with Reduce motion, once it has faded). `then` is dropped when the sheet
   * is opened again meanwhile, and when nothing is open.
   */
  readonly closeThen: (then: () => void) => void;
  /**
   * Moves the open sheet to the card `cardId` on the page, where it stands, as
   * J and K do. The sheet's way back starts again from it. Does nothing when
   * nothing is open.
   */
  readonly walk: (cardId: string) => void;
  /** What `InboxOpenCard` draws from. Nothing else needs it. */
  readonly sheet: OpenCardSheet;
}

/** The state `InboxOpenCard` draws, and the moves that happen inside the sheet. */
export interface OpenCardSheet {
  /** True from `open` until `close`. The sheet stays drawn after that until `finishClose`. */
  readonly isOpen: boolean;
  /** The card or place the sheet shows. It stays set while the sheet folds home. */
  readonly shown: OpenTarget | null;
  /** What the sheet showed before each place or card walked to inside it, the latest last. */
  readonly trail: readonly OpenTarget[];
  /**
   * The element of what the sheet shows, which it folds back into, or `null`
   * when that is not on the page: then the sheet only fades away.
   */
  readonly originElement: HTMLElement | null;
  /** Shows `target` inside the sheet, keeping the way back. The sheet folds into `target` from then on. */
  readonly walkInside: (target: OpenTarget) => void;
  /** Shows what the sheet showed before the last `walkInside`. */
  readonly walkBack: () => void;
  /**
   * Forgets the sheet, once it has folded home, and runs what `closeThen` was
   * given. Does nothing when it was opened again meanwhile.
   */
  readonly finishClose: () => void;
}

interface OpenState {
  readonly isOpen: boolean;
  readonly origin: OpenTarget | null;
  readonly shown: OpenTarget | null;
  readonly trail: readonly OpenTarget[];
  readonly originElement: HTMLElement | null;
}

const NOTHING_OPEN: OpenState = {
  isOpen: false,
  origin: null,
  shown: null,
  trail: [],
  originElement: null,
};

/** Holds the open card of the Inbox page. See `OpenCard` for what it offers. */
export const useOpenCard = (): OpenCard => {
  const [state, setState] = useState(NOTHING_OPEN);
  const afterClose = useRef<(() => void) | null>(null);
  const close = (): void => {
    setState((was) => (was.isOpen ? { ...was, isOpen: false } : was));
  };
  return {
    isOpen: state.isOpen,
    origin: state.isOpen ? state.origin : null,
    shown: state.isOpen ? state.shown : null,
    open: (target, originElement) => {
      afterClose.current = null;
      setState({
        isOpen: true,
        origin: target,
        shown: target,
        trail: [],
        originElement,
      });
    },
    close,
    closeThen: (then) => {
      if (!state.isOpen) return;
      afterClose.current = then;
      close();
    },
    walk: (cardId) => {
      afterClose.current = null;
      const target: OpenTarget = { kind: "card", id: cardId };
      setState((was) =>
        was.isOpen
          ? {
              ...was,
              origin: target,
              shown: target,
              trail: [],
              originElement: findCardOrPlaceElement(target, was.originElement),
            }
          : was,
      );
    },
    sheet: {
      isOpen: state.isOpen,
      shown: state.shown,
      trail: state.trail,
      originElement: state.originElement,
      walkInside: (target) => {
        setState((was) =>
          was.isOpen && was.shown !== null && !isSameTarget(was.shown, target)
            ? {
                ...was,
                shown: target,
                trail: [...was.trail, was.shown],
                originElement: findCardOrPlaceElement(target, was.originElement),
              }
            : was,
        );
      },
      walkBack: () => {
        setState((was) => {
          const back = was.trail.at(-1);
          return was.isOpen && back !== undefined
            ? {
                ...was,
                shown: back,
                trail: was.trail.slice(0, -1),
                originElement: findCardOrPlaceElement(back, was.originElement),
              }
            : was;
        });
      },
      finishClose: () => {
        const then = afterClose.current;
        afterClose.current = null;
        setState((was) => (was.isOpen ? was : NOTHING_OPEN));
        then?.();
      },
    },
  };
};

/** Returns whether `a` and `b` stand for the same card or the same place. */
export const isSameTarget = (a: OpenTarget, b: OpenTarget): boolean =>
  a.kind === "card" ? b.kind === "card" && a.id === b.id : b.kind === "place" && a.ref === b.ref;
