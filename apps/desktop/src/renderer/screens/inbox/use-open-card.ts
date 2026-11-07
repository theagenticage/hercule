/**
 * What the Inbox keeps about its open card: which card or place the sheet is
 * on, where it opened from, and the way back through what was walked to inside
 * it. The sheet itself (`InboxOpenCard`) draws from this; the page's keys and
 * clicks drive it.
 */
import { useState } from "react";

/**
 * The open card, as the page's keys and clicks use it. An id is a card's id, or
 * the ref of a place when a place's head was opened.
 */
export interface OpenCard {
  /**
   * The card or place the sheet opened from, or `null` while nothing is open
   * (also while the sheet folds home). J and K step from it, and it is not
   * changed by walking to a place inside the sheet.
   */
  readonly openId: string | null;
  /**
   * Opens the sheet on `id`, from `originElement`, the card's element on the
   * page. Called again while open, it moves the sheet to `id` where it stands.
   * Called while the sheet folds home, it turns round.
   */
  open(id: string, originElement: HTMLElement): void;
  /** Folds the sheet back into the card it opened from. Does nothing when nothing is open. */
  close(): void;
  /**
   * Moves the open sheet to the card or place `id` on the page, where it
   * stands, as J and K do. The sheet's way back starts again from `id`. Does
   * nothing when nothing is open.
   */
  walk(id: string): void;
  /** What `InboxOpenCard` draws from. Nothing else needs it. */
  readonly sheet: OpenCardSheet;
}

/** The state `InboxOpenCard` draws, and the moves that happen inside the sheet. */
export interface OpenCardSheet {
  /** True from `open` until `close`. The sheet stays drawn after that until `finishClose`. */
  readonly isOpen: boolean;
  /** The card or place the sheet shows. It stays set while the sheet folds home. */
  readonly shownId: string | null;
  /** What the sheet showed before each place walked to inside it, the latest last. */
  readonly trail: readonly string[];
  /**
   * The element of what the sheet shows, which it folds back into, or `null`
   * when that is not on the page: then the sheet only fades away.
   */
  readonly originElement: HTMLElement | null;
  /** Shows the place or card `id` inside the sheet, keeping the way back. The sheet folds into `id` from then on. */
  walkInside(id: string): void;
  /** Shows what the sheet showed before the last `walkInside`. */
  walkBack(): void;
  /** Forgets the sheet, once it has folded home. Does nothing when it was opened again meanwhile. */
  finishClose(): void;
}

interface OpenState {
  readonly isOpen: boolean;
  readonly originId: string | null;
  readonly shownId: string | null;
  readonly trail: readonly string[];
  readonly originElement: HTMLElement | null;
}

const NOTHING_OPEN: OpenState = {
  isOpen: false,
  originId: null,
  shownId: null,
  trail: [],
  originElement: null,
};

/**
 * Returns the element on the page that stands for the card or place `id`,
 * searched in the desk `near` lies in. Returns `null` when none is drawn.
 */
const findElementOf = (id: string, near: HTMLElement | null): HTMLElement | null => {
  const desk = near?.closest(".inbox-desk") ?? document;
  for (const element of desk.querySelectorAll<HTMLElement>("[data-card-id], [data-place-ref]")) {
    if (element.dataset["cardId"] === id || element.dataset["placeRef"] === id) return element;
  }
  return null;
};

/** Holds the open card of the Inbox page. See `OpenCard` for what it offers. */
export const useOpenCard = (): OpenCard => {
  const [state, setState] = useState(NOTHING_OPEN);
  return {
    openId: state.isOpen ? state.originId : null,
    open: (id, originElement) => {
      setState({
        isOpen: true,
        originId: id,
        shownId: id,
        trail: [],
        originElement,
      });
    },
    close: () => {
      setState((was) => (was.isOpen ? { ...was, isOpen: false } : was));
    },
    walk: (id) => {
      setState((was) =>
        was.isOpen
          ? {
              ...was,
              originId: id,
              shownId: id,
              trail: [],
              originElement: findElementOf(id, was.originElement),
            }
          : was,
      );
    },
    sheet: {
      isOpen: state.isOpen,
      shownId: state.shownId,
      trail: state.trail,
      originElement: state.originElement,
      walkInside: (id) => {
        setState((was) =>
          was.isOpen && was.shownId !== null && was.shownId !== id
            ? {
                ...was,
                shownId: id,
                trail: [...was.trail, was.shownId],
                originElement: findElementOf(id, was.originElement),
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
                shownId: back,
                trail: was.trail.slice(0, -1),
                originElement: findElementOf(back, was.originElement),
              }
            : was;
        });
      },
      finishClose: () => {
        setState((was) => (was.isOpen ? was : NOTHING_OPEN));
      },
    },
  };
};
