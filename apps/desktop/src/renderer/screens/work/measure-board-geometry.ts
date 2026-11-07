import type { ArrangedLane } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage } from "@hercule/contract";
import { measureLayoutRect, type LayoutRect } from "../../app/motion";
import type { BoardGeometry, BoardView, CellBox, LaneBox, StageEdge } from "./board-drag-geometry";
import { buildCardKey } from "./flip-board";

/** The measurements of the board a carry needs: the geometry, and the scroller it was measured in. */
export interface MeasuredBoard {
  readonly geometry: BoardGeometry;
  readonly view: BoardView;
}

/** Returns the stage `value` names, or `undefined` when it names none. */
const readStage = (value: string | undefined): BoardStage | undefined =>
  BOARD_STAGES.find((stage) => stage === value);

/**
 * Measures the stage edges, the lanes, the cells and the cards of the board
 * under `scroller`, in board coordinates (`BoardGeometry`). `arrangedLanes` are
 * the lanes the page was drawn from: they say which lanes are folded and which
 * cells hide cards behind a line, so the page is not asked. Cards are where
 * the layout puts them, with the offsets of cards that are still gliding taken
 * away, so the answer is the same whether or not a spring is running.
 *
 * `places` are card places that a flip just measured (`flipBoard`), by card
 * key. A card found in them is not measured again. Without them, every card is
 * measured.
 */
export const measureBoardGeometry = (
  scroller: HTMLElement,
  arrangedLanes: readonly ArrangedLane[],
  places?: ReadonlyMap<string, LayoutRect>,
): MeasuredBoard => {
  const frame = scroller.getBoundingClientRect();
  const view: BoardView = {
    left: frame.left,
    top: frame.top,
    bottom: frame.bottom,
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop,
  };
  const toBoardLeft = (left: number): number => left - view.left + view.scrollLeft;
  const toBoardTop = (top: number): number => top - view.top + view.scrollTop;

  const stageEdges: StageEdge[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>(".board-rule [data-stage]")) {
    const stage = readStage(element.dataset["stage"]);
    if (stage !== undefined) {
      stageEdges.push({ stage, left: toBoardLeft(element.getBoundingClientRect().left) });
    }
  }

  const lanes = [...scroller.querySelectorAll<HTMLElement>(".board-lane[data-lane-id]")].flatMap(
    (element): LaneBox[] => {
      const arranged = arrangedLanes.find((each) => each.lane.id === element.dataset["laneId"]);
      if (arranged === undefined) return [];
      const rect = element.getBoundingClientRect();
      const cells = new Map<BoardStage, CellBox>();
      for (const cell of element.querySelectorAll<HTMLElement>(".board-cell[data-stage]")) {
        const stage = readStage(cell.dataset["stage"]);
        if (stage === undefined) continue;
        const shownCards = [...cell.children].filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.dataset["cardId"] !== undefined,
        );
        const rows = shownCards.flatMap((child) => {
          const { cardId, dragged } = child.dataset;
          if (cardId === undefined || dragged !== undefined) return [];
          const place = places?.get(buildCardKey(cardId)) ?? measureLayoutRect(child);
          return [{ id: cardId, element: child, middle: toBoardTop(place.top + place.height / 2) }];
        });
        // The card in the hand still counts as shown: it leaves a place that a drop may take again.
        const hasClosedMoreLine =
          arranged.cells.find((each) => each.stage === stage)?.arrangement.foot === "more";
        cells.set(stage, {
          element: cell,
          rows,
          ...(hasClosedMoreLine ? { lastIndex: shownCards.length - 1 } : {}),
        });
      }
      return [
        {
          id: arranged.lane.id,
          element,
          top: toBoardTop(rect.top),
          bottom: toBoardTop(rect.bottom),
          isFolded: arranged.isFolded,
          cells,
        },
      ];
    },
  );
  return { geometry: { stageEdges, lanes }, view };
};
