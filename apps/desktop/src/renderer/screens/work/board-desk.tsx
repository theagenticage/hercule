import type { JSX, ReactNode, RefObject } from "react";
import { BOARD_STAGES, type BoardStage } from "@hercule/contract";
import { STAGE_NAMES } from "@hercule/client-core/work";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import { SectionHeading, Sunrise } from "../desk";
import type { LaneLabels } from "./use-work-view";
import "./work.css";

/** What the desk is showing, which the stylesheet reads from `data-state`. */
export type DeskState = "loading" | "board" | "first-run" | "clear";

/**
 * Renders the frame of the Work board: the desk, the stage headers that stay
 * under the toolbar while the board scrolls, and the room for what the desk
 * holds.
 *
 * - `toolbar` and `overlays` are drawn over the desk, in the desk's own
 *   positioning: the toolbar floats at the top, and the sheet and the undo
 *   line sit over the board.
 * - `children` are the desk's body under the headers: lanes, a loading
 *   state, or an empty page.
 * - `stageCounts` are the number beside each stage's name. A count of zero is
 *   not drawn, and `null` draws none at all, for a board not read yet.
 * - `laneLabels` is how lanes label themselves; `isOffline` takes the colour
 *   out of the colleagues.
 * - `isCarrying` is whether a card is in the hand of a drag, which the
 *   stylesheet reads from `data-carrying`.
 * - `hasSheet` and `isArriving` are described on their props.
 * - `state` is what the desk shows. A clear desk draws the sunrise over the
 *   hairline and hides the stage names.
 * - `scrollRef` is the element that scrolls, which drag and keyboard code
 *   scroll and measure.
 *
 * The root carries `data-lanes`, `data-state` and, while a card is in the hand, `data-carrying`. The element that scrolls is
 * `.board-scroll`, and the headers are `[data-stage]` children of `.board-rule`.
 */
export function BoardDesk({
  toolbar,
  overlays,
  children,
  stageCounts,
  laneLabels,
  isOffline,
  isCarrying,
  hasSheet,
  isArriving,
  state,
  scrollRef,
}: {
  readonly toolbar: ReactNode;
  readonly overlays: ReactNode;
  readonly children: ReactNode;
  readonly stageCounts: Readonly<Record<BoardStage, number>> | null;
  readonly laneLabels: LaneLabels;
  readonly isOffline: boolean;
  readonly isCarrying: boolean;
  /** Whether the Add sheet is open, which moves the undo line clear of it. */
  readonly hasSheet: boolean;
  /** Whether the first board is arriving: its cards fade their words in from the top left. */
  readonly isArriving: boolean;
  readonly state: DeskState;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const hasScrollbar = useShowsClassicScrollbar(scrollRef);
  const classes = [
    "work-desk",
    isOffline ? "is-offline" : null,
    hasScrollbar ? "has-scrollbar" : null,
    hasSheet ? "has-sheet" : null,
    isArriving ? "is-arriving" : null,
  ]
    .filter((each) => each !== null)
    .join(" ");
  return (
    <div
      className={classes}
      data-lanes={laneLabels === "bands" ? "band" : "side"}
      data-state={state}
      data-carrying={isCarrying ? "" : undefined}
    >
      {toolbar}
      <div ref={scrollRef} className="board-scroll">
        <div className="board-canvas">
          <div className="board-rule-wrap">
            <div className="board-rule">
              {BOARD_STAGES.map((stage) => (
                <div key={stage} className="board-stage" data-stage={stage}>
                  <SectionHeading name={STAGE_NAMES[stage]} count={stageCounts?.[stage] ?? 0} />
                </div>
              ))}
            </div>
            {state === "clear" && <Sunrise />}
          </div>
          {children}
        </div>
      </div>
      {overlays}
    </div>
  );
}
