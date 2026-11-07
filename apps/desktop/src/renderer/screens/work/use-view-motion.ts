import { flushSync } from "react-dom";
import type { RefObject } from "react";
import { ROWS_BEFORE_HIDING } from "@hercule/client-core/work";
import {
  fadeInCards,
  flyFlightsTo,
  FOLD_GAP,
  growCardsFromOrigins,
  INTO_COUNT,
  launchFlights,
  recordGrowthOrigins,
  TO_BUTTON,
} from "./board-flights";
import { flipBoard } from "./flip-board";
import type { WorkView } from "./use-work-view";

/** How long the lanes below a folding lane wait before they glide up, in milliseconds. */
const LANES_BELOW_WAIT = 70;

/** How far below the top of the view a lane's bottom must be for the lane to count as the one at the top. */
const ANCHOR_DEPTH = 120;

/** One change the user asked for, and how the board plays it. */
interface BoardChange {
  /** Makes the change in the screen's state. It is committed before the board is measured again. */
  readonly commit: () => void;
  /**
   * The element that stays exactly where it is on screen while everything else
   * moves around it: the lane or the button the user clicked, `"top"` for the
   * lane at the top of the view, or `"none"` so that the page does not scroll.
   */
  readonly anchor: HTMLElement | "top" | "none";
  /** The milliseconds each part waits before it glides. */
  readonly wait?: number | undefined;
  /**
   * Runs before the change and returns what runs after it, with the parts of
   * the board that are new. It makes the copies in flight and records where
   * cards grow from.
   */
  readonly prepare?: () => (born: readonly HTMLElement[]) => void;
}

/** What a fold or an unfold needs to know: the lanes it changes, how to commit it, and the lane that stays still. */
interface FoldRequest {
  readonly lanes: readonly HTMLElement[];
  readonly commit: () => void;
  readonly anchor: BoardChange["anchor"];
}

/** Returns the lane at the top of the view: the first whose bottom is clear of the toolbar and the stage names. */
const findLaneAtTop = (scroller: HTMLElement): HTMLElement | null => {
  const top = scroller.getBoundingClientRect().top + ANCHOR_DEPTH;
  for (const lane of scroller.querySelectorAll<HTMLElement>(".board-lane")) {
    if (lane.getBoundingClientRect().bottom > top) return lane;
  }
  return null;
};

/**
 * Plays one change as a single movement on `travel`: everything on the board
 * that moves because of it glides from where it was, and the anchor lane does
 * not move on screen (the page scrolls to keep it still). Without a board
 * to measure, only commits the change.
 */
const playChange = (scroller: HTMLElement | null, change: BoardChange): void => {
  if (scroller === null) {
    change.commit();
    return;
  }
  const anchor =
    change.anchor === "top"
      ? findLaneAtTop(scroller)
      : change.anchor === "none"
        ? null
        : change.anchor;
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const finish = change.prepare?.();
  const wait = change.wait ?? 0;
  const { born } = flipBoard(
    scroller,
    "travel",
    () => {
      flushSync(change.commit);
      if (anchor?.isConnected === true) {
        scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      }
    },
    wait > 0 ? () => wait : undefined,
  );
  finish?.(born);
};

/** Finds the section of a lane. */
const findLane = (scroller: HTMLElement, laneId: string): HTMLElement | null =>
  scroller.querySelector<HTMLElement>(`.board-lane[data-lane-id="${CSS.escape(laneId)}"]`);

/** Returns the cards under `elements`, in order. */
const listCards = (elements: readonly Element[]): HTMLElement[] =>
  elements.flatMap((element) => [...element.querySelectorAll<HTMLElement>("[data-card-id]")]);

/**
 * Returns a change that folds `lanes`: the lanes below glide up after a short
 * wait, and, when `hasFlights` is true, a copy of each card in view flies to
 * its count first.
 */
const buildFold = (
  scroller: HTMLElement,
  { lanes, commit, anchor, hasFlights }: FoldRequest & { readonly hasFlights: boolean },
): BoardChange => ({
  commit,
  anchor,
  wait: LANES_BELOW_WAIT,
  prepare: () => {
    const flights = hasFlights ? launchFlights(scroller, listCards(lanes), FOLD_GAP) : [];
    return () => {
      flyFlightsTo(
        flights,
        (flight) =>
          scroller.querySelector(
            `[data-fold-row="${CSS.escape(flight.laneId)}"] [data-stage="${flight.stage}"]`,
          ),
        INTO_COUNT,
      );
    };
  },
});

/** Returns a change that opens `lanes`: each card grows out of its count, or out of the copy still flying there. */
const buildUnfold = (
  scroller: HTMLElement,
  { lanes, commit, anchor }: FoldRequest,
): BoardChange => ({
  commit,
  anchor,
  prepare: () => {
    const origins = recordGrowthOrigins(scroller, lanes);
    return () => {
      growCardsFromOrigins(lanes, origins);
    };
  },
});

/** Returns the ids of the cards under `element`. */
const listCardIds = (element: Element): Set<string> =>
  new Set(
    [...element.querySelectorAll<HTMLElement>("[data-card-id]")].map(
      (card) => card.dataset["cardId"] ?? "",
    ),
  );

/**
 * Returns the cards of `cell` that a closed cell does not show: all of them
 * in the Landed cell, and the ones past the first rows in the other cells.
 * A row is a card alone, or a lead with its stack, so the members of an open
 * stack go with their lead's row.
 */
const listCardsPastTheLimit = (cell: HTMLElement): HTMLElement[] =>
  listCards([...cell.children].slice(cell.dataset["stage"] === "landed" ? 0 : ROWS_BEFORE_HIDING));

/** Fades in, from 6px above, every card under `root` that is not in `before`: a card the change brought in. */
const fadeInCardsNotIn = (root: Element, before: ReadonlySet<string>): void => {
  const born = [...root.querySelectorAll<HTMLElement>("[data-card-id]")].filter(
    (card) => !before.has(card.dataset["cardId"] ?? ""),
  );
  fadeInCards(born, "travel");
};

/**
 * Returns `view` with each change the user makes played as the board's
 * motion (MOTION.md). What a change does to the lanes and cells is read from
 * `view`, not from the page:
 *
 * - Folding a lane, or Fold everything: a copy of each card in view flies to
 *   its count and shrinks, 12ms apart, and the lanes below wait 70ms and glide
 *   up. Opening plays it back: each card grows from its count, 16ms apart.
 *   Fold everything is one change however many lanes it touches.
 * - "13 more" and "3 landed": the cards fade in from 6px above, under the last
 *   one, and everything below glides down. "Show fewer" sends each card back to
 *   the button.
 * - A stack's sheet works like "13 more": its members fade in from 6px above,
 *   under their lead, and closing it sends each member back to the sheet.
 * - Filter and Find: one change. What stays glides from where it was; what
 *   leaves just goes; what comes back fades in.
 * - A new grouping is the same change, and the page returns to its top,
 *   because the old scroll position means nothing under the new lanes.
 *
 * `scrollRef` holds the element that scrolls the board; it is read when a
 * change is made, never while rendering. Every spring is `travel`: the user asked for these. The change to the screen
 * is committed at once (`flushSync`), because the board is measured right
 * after it. Call the returned functions from events, not from effects.
 */
export const useViewMotion = (
  view: WorkView,
  scrollRef: RefObject<HTMLElement | null>,
): WorkView => {
  const toggleLane = (laneId: string): void => {
    const scroller = scrollRef.current;
    const lane = scroller === null ? null : findLane(scroller, laneId);
    if (scroller === null || lane === null) {
      view.toggleLane(laneId);
      return;
    }
    const commit = (): void => {
      view.toggleLane(laneId);
    };
    const request = { lanes: [lane], commit, anchor: lane };
    playChange(
      scroller,
      view.foldedLaneIds.has(laneId)
        ? buildUnfold(scroller, request)
        : buildFold(scroller, { ...request, hasFlights: !view.isFiltering }),
    );
  };

  const foldEverything = (laneIds: readonly string[]): void => {
    const scroller = scrollRef.current;
    const lanes =
      scroller === null
        ? []
        : laneIds.flatMap((id) => {
            const lane = findLane(scroller, id);
            return lane === null ? [] : [lane];
          });
    const commit = (): void => {
      view.foldEverything(laneIds);
    };
    if (scroller === null || lanes.length === 0) {
      commit();
      return;
    }
    // Fold everything opens the lanes when all are folded, and folds the open ones otherwise.
    const isOpening = laneIds.every((id) => view.foldedLaneIds.has(id));
    playChange(
      scroller,
      isOpening
        ? buildUnfold(scroller, { lanes, commit, anchor: "top" })
        : buildFold(scroller, {
            lanes: lanes.filter((lane) => !view.foldedLaneIds.has(lane.dataset["laneId"] ?? "")),
            commit,
            anchor: "top",
            hasFlights: true,
          }),
    );
  };

  const toggleCell = (cellId: string): void => {
    const scroller = scrollRef.current;
    const cell =
      scroller?.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`) ?? null;
    if (scroller === null || cell === null) {
      view.toggleCell(cellId);
      return;
    }
    const isClosing = view.openedCellIds.has(cellId);
    // The page keeps the pressed button still, so the pointer stays on it. Anchoring the lane
    // instead would leave the button far off screen after "Show fewer" in a deep cell.
    const button = scroller.querySelector<HTMLElement>(
      `[data-more-cell-id="${CSS.escape(cellId)}"]`,
    );
    playChange(scroller, {
      commit: () => {
        view.toggleCell(cellId);
      },
      anchor: button ?? "none",
      prepare: () => {
        const flights = isClosing ? launchFlights(scroller, listCardsPastTheLimit(cell), 0) : [];
        const before = listCardIds(cell);
        return () => {
          if (isClosing) {
            // A copy flies back to the button of its cell only if its card left the page.
            const buttonAfter = scroller.querySelector(
              `[data-more-cell-id="${CSS.escape(cellId)}"]`,
            );
            flyFlightsTo(
              flights,
              (flight) =>
                scroller.querySelector(`[data-card-id="${flight.cardId}"]`) === null
                  ? buttonAfter
                  : null,
              TO_BUTTON,
            );
            return;
          }
          fadeInCardsNotIn(cell, before);
        };
      },
    });
  };

  const toggleStack = (stackId: string): void => {
    const scroller = scrollRef.current;
    const findBar = (): HTMLElement | null =>
      scroller?.querySelector<HTMLElement>(`[data-stack-bar="${CSS.escape(stackId)}"]`) ?? null;
    const bar = findBar();
    const stack = bar?.closest<HTMLElement>(".board-stack") ?? null;
    if (scroller === null || bar === null || stack === null) {
      view.toggleStack(stackId);
      return;
    }
    const isClosing = view.openedStackIds.has(stackId);
    // The page keeps the pressed bar still, so the pointer stays on it.
    playChange(scroller, {
      commit: () => {
        view.toggleStack(stackId);
      },
      anchor: bar,
      prepare: () => {
        const flights = isClosing
          ? launchFlights(
              scroller,
              listCards([...stack.querySelectorAll(".board-stack-members")]),
              0,
            )
          : [];
        const before = listCardIds(stack);
        return () => {
          if (isClosing) {
            flyFlightsTo(flights, findBar, TO_BUTTON);
            return;
          }
          const opened = findBar()?.closest<HTMLElement>(".board-stack") ?? null;
          if (opened !== null) fadeInCardsNotIn(opened, before);
        };
      },
    });
  };

  /**
   * Plays a change of what the board filters by: nothing flies and the page
   * does not scroll. A card the change brings back fades in; one it takes away
   * just goes.
   */
  const playFilterChange = (commit: () => void): void => {
    const scroller = scrollRef.current;
    playChange(scroller, {
      commit,
      anchor: "none",
      prepare: () => {
        const before = scroller === null ? new Set<string>() : listCardIds(scroller);
        return () => {
          if (scroller !== null) fadeInCardsNotIn(scroller, before);
        };
      },
    });
  };

  /** Plays a new grouping of the lanes: the cards glide to their new lanes, and a card that has a copy there now fades in. */
  const setGroupBy = (groupBy: string): void => {
    const scroller = scrollRef.current;
    playChange(scroller, {
      commit: () => {
        view.setGroupBy(groupBy);
        if (scroller !== null) scroller.scrollTop = 0;
      },
      anchor: "none",
      prepare: () => (born) => {
        fadeInCards(
          born.filter((part) => part.hasAttribute("data-card-id")),
          "travel",
        );
      },
    });
  };

  return {
    ...view,
    setGroupBy,
    toggleLane,
    foldEverything,
    toggleCell,
    toggleStack,
    setFilter: (filter) => {
      playFilterChange(() => {
        view.setFilter(filter);
      });
    },
    setFindText: (text) => {
      playFilterChange(() => {
        view.setFindText(text);
      });
    },
  };
};
