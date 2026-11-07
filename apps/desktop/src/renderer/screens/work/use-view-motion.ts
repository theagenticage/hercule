import { flushSync } from "react-dom";
import type { RefObject } from "react";
import { flipByKey } from "../../app/motion";
import {
  fadeInCards,
  flyFlightsIntoCounts,
  flyFlightsToButton,
  growCardsFromOrigins,
  launchCloseFlights,
  launchFoldFlights,
  recordGrowthOrigins,
} from "./board-flights";
import { MOVABLE_SELECTOR, readMotionKey } from "./board-layouts";
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
   * The lane that stays exactly where it is on screen while everything else
   * moves around it: the one the user clicked. `undefined` means the lane at
   * the top of the view; `null` means none, so the page does not scroll.
   */
  readonly anchor?: HTMLElement | null | undefined;
  /** The milliseconds each part waits before it glides. */
  readonly wait?: number | undefined;
  /** Runs before the change and returns what runs after it. It makes the copies in flight and records where cards grow from. */
  readonly prepare?: () => () => void;
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
  const anchor = change.anchor === undefined ? findLaneAtTop(scroller) : change.anchor;
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const finish = change.prepare?.();
  const wait = change.wait ?? 0;
  flipByKey({
    root: scroller,
    selector: MOVABLE_SELECTOR,
    readKey: readMotionKey,
    spring: "travel",
    ...(wait > 0 ? { stagger: () => wait } : {}),
    mutate: () => {
      flushSync(change.commit);
      if (anchor?.isConnected === true) {
        scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      }
    },
  });
  finish?.();
};

/** Finds the section of a lane. */
const findLane = (scroller: HTMLElement, laneId: string): HTMLElement | null =>
  scroller.querySelector<HTMLElement>(`.board-lane[data-lane-id="${laneId}"]`);

/** Returns whether a lane shows folded: its line of counts stands where its cells would. */
const isLaneFolded = (lane: HTMLElement): boolean =>
  lane.querySelector(":scope > [data-fold-row]") !== null;

/** Returns a change that folds `lanes`: a copy of each card in view flies to its count, and the lanes below glide up after a short wait. */
const buildFold = (
  scroller: HTMLElement,
  lanes: readonly HTMLElement[],
  commit: () => void,
  anchor: HTMLElement | null | undefined,
  withFlights: boolean,
): BoardChange => ({
  commit,
  anchor,
  wait: LANES_BELOW_WAIT,
  prepare: () => {
    const flights = withFlights ? launchFoldFlights(scroller, lanes) : [];
    return () => {
      flyFlightsIntoCounts(scroller, flights);
    };
  },
});

/** Returns a change that opens `lanes`: each card grows out of its count, or out of the copy still flying there. */
const buildUnfold = (
  scroller: HTMLElement,
  lanes: readonly HTMLElement[],
  commit: () => void,
  anchor: HTMLElement | null | undefined,
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

/** Fades in, from 6px above, every card under `root` that is not in `before`: a card the change brought in. */
const fadeInCardsNotIn = (root: Element, before: ReadonlySet<string>): void => {
  const born = [...root.querySelectorAll<HTMLElement>("[data-card-id]")].filter(
    (card) => !before.has(card.dataset["cardId"] ?? ""),
  );
  fadeInCards(born, "travel");
};

/**
 * Returns `view` with each change the user makes played as the board's
 * motion (MOTION.md):
 *
 * - Folding a lane, or Fold everything: a copy of each card in view flies to
 *   its count and shrinks, 12ms apart, and the lanes below wait 70ms and glide
 *   up. Opening plays it back: each card grows from its count, 16ms apart.
 *   Fold everything is one change however many lanes it touches.
 * - "13 more" and "3 landed": the cards fade in from 6px above, under the last
 *   one, and everything below glides down. "Show fewer" sends each card back to
 *   the button.
 * - Filter and Find: one change. What stays glides from where it was; what
 *   leaves just goes; what comes back fades in.
 *
 * Every spring is `travel`: the user asked for these. The change to the screen
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
    playChange(
      scroller,
      isLaneFolded(lane)
        ? buildUnfold(scroller, [lane], commit, lane)
        : buildFold(scroller, [lane], commit, lane, !view.isFiltering),
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
    const isOpening = lanes.every(isLaneFolded);
    playChange(
      scroller,
      isOpening
        ? buildUnfold(scroller, lanes, commit, undefined)
        : buildFold(
            scroller,
            lanes.filter((lane) => !isLaneFolded(lane)),
            commit,
            undefined,
            true,
          ),
    );
  };

  const toggleCell = (cellId: string): void => {
    const scroller = scrollRef.current;
    const cell = scroller?.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`) ?? null;
    if (scroller === null || cell === null) {
      view.toggleCell(cellId);
      return;
    }
    const button = scroller.querySelector(`[data-more-cell-id="${cellId}"]`);
    const isClosing = button?.getAttribute("aria-expanded") === "true";
    playChange(scroller, {
      commit: () => {
        view.toggleCell(cellId);
      },
      anchor: cell.closest<HTMLElement>(".board-lane"),
      prepare: () => {
        const flights = isClosing ? launchCloseFlights(scroller, cell) : [];
        const before = listCardIds(cell);
        return () => {
          if (isClosing) {
            flyFlightsToButton(scroller, cellId, flights);
            return;
          }
          fadeInCardsNotIn(cell, before);
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
      anchor: null,
      prepare: () => {
        const before = scroller === null ? new Set<string>() : listCardIds(scroller);
        return () => {
          if (scroller !== null) fadeInCardsNotIn(scroller, before);
        };
      },
    });
  };

  return {
    ...view,
    toggleLane,
    foldEverything,
    toggleCell,
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
