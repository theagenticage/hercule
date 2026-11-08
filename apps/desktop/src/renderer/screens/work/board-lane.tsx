import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { buildRelationProgress } from "@hercule/client-core/desk";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { FolderIcon } from "../../icons/folder";
import { PlusIcon } from "../../icons/plus";
import type { WorkCard } from "@hercule/contract";
import {
  NO_INITIATIVE_LANE_ID,
  STAGE_NAMES,
  type ArrangedLane,
  type ArrangedLaneCell,
  type CardInLane,
  type HeldInitiative,
  type OutsideLane,
  type WorkInitiative,
} from "@hercule/client-core/work";
import { PluginMark } from "../../marks";
import { HueFlag, ProgressBar } from "../desk";
import { BoardCell } from "./board-cell";
import type { PressedKeys } from "./work-card";

/** The Initiatives a lane holds when the caller passes none. */
const HOLDS_NONE: readonly HeldInitiative[] = [];

/**
 * Returns what the line of counts of a folded lane says to a screen reader,
 * such as "Exploring 2, Building 1 with a failure". The sighted board shows the
 * counts under each stage and a coloured dot, which words cannot read.
 */
const describeFoldedCounts = (cells: readonly ArrangedLaneCell[]): string => {
  const words = cells
    .filter((cell) => cell.cardCountWithRows > 0)
    .map((cell) => {
      const dot =
        cell.dot === "failed"
          ? " with a failure"
          : cell.dot === "question"
            ? " with a question"
            : "";
      return `${STAGE_NAMES[cell.stage]} ${String(cell.cardCountWithRows)}${dot}`;
    });
  return words.length === 0 ? "No cards" : words.join(", ");
};

/**
 * Renders what an outside place says about itself under its name: what kind
 * of place it is and its status, such as "GitHub repository · Open", then a
 * 4px bar and "6 of 14" only when the source reports progress. A lane that
 * collects what has no place says nothing about itself.
 */
function OutsideFacts({ outside }: { readonly outside: OutsideLane }): JSX.Element | null {
  const words = [outside.caption, outside.status?.label].filter((word) => word !== undefined);
  if (outside.pluginId === null) return null;
  const progress =
    outside.progress === undefined ? undefined : buildRelationProgress(outside.progress);
  return (
    <small className="board-lane-facts">
      {words.join(" · ")}
      {progress !== undefined && (
        <>
          {" "}
          <ProgressBar
            fraction={progress.fraction}
            {...(progress.words === undefined ? {} : { words: progress.words })}
          />
        </>
      )}
    </small>
  );
}

/**
 * Renders one lane of the board: its head, and under it either its five cells
 * or, when it is folded, one line with the number of cards under each stage.
 *
 * - The head is a button that folds or opens the lane, with a chevron, a
 *   folder, the Project's name, how many cards the lane holds, and "1 failed"
 *   in ink when a card failed, whether the lane is folded or not. The `+`
 *   beside it adds a Task to this lane. The count, the failures, the counts
 *   of a folded lane and its dots stand for every Task of the Project: the
 *   cards of the rows drawn under the lane (In lanes) are in them, though the
 *   rows draw those cards themselves.
 * - The lane of an outside place, such as a repository, has the source's
 *   mark in place of the folder and says what the place says about itself
 *   under its name (`OutsideFacts`). The lane that collects what has no such
 *   place, and the lane "Not in an initiative", have a ring in place of the
 *   folder and no `+`.
 * - A folded lane shows a 6px dot under a stage that holds a card with a
 *   question (marigold) or a failure (tomato).
 * - The lane of an Initiative (Group by Initiative) has the Initiative's flag
 *   in its colour in place of the folder.
 * - A folded Project lane keeps a small flag for each Initiative it holds
 *   (`heldInitiatives`, from `listLaneInitiatives`), so that the rows it hides
 *   leave a trace. An open lane shows none, because the rows are under it.
 *
 * The section carries `data-lane-id`, the head `data-lane-head`, and the line
 * of counts `data-fold-row`, which motion and keyboard code find them by.
 */
export function BoardLane({
  arrangedLane,
  plugins,
  initiativeFlags,
  tabStop,
  isStill,
  canWriteSummaries,
  selectedIds,
  heldInitiatives,
  onToggleLane,
  onToggleCell,
  onToggleStack,
  onAddTask,
  onPressCard,
  onFocusCard,
}: {
  readonly arrangedLane: ArrangedLane;
  readonly plugins: readonly PluginIdentity[];
  /**
   * The Initiatives whose small flag a card of the Initiative draws, by id.
   * Absent under a grouping where cards draw no flag (Group by Project).
   */
  readonly initiativeFlags?: ReadonlyMap<string, WorkInitiative> | undefined;
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  /** The ids of the selected cards, which draw selected. */
  readonly selectedIds: ReadonlySet<string>;
  /** The Initiatives whose rows stand under this lane, in order. Drawn as flags while the lane is folded. */
  readonly heldInitiatives?: readonly HeldInitiative[];
  readonly onToggleLane: (laneId: string) => void;
  readonly onToggleCell: (cellId: string) => void;
  readonly onToggleStack: (stackId: string) => void;
  readonly onAddTask: (laneId: string) => void;
  /** Called with the card and the keys held when a card is clicked. */
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const { lane, isFolded, failedCount, cardCountWithRows, cells } = arrangedLane;
  const { outside, initiative } = lane;
  const held = heldInitiatives ?? HOLDS_NONE;
  const isNoPlace = outside?.pluginId === null || lane.id === NO_INITIATIVE_LANE_ID;
  return (
    <section
      className={isFolded ? "board-lane is-folded" : "board-lane"}
      data-lane-id={lane.id}
      // The stylesheet spaces a lane by what it draws and by the rows that follow it.
      data-has-cards={
        isFolded || !cells.some((cell) => cell.shownCards.length > 0) ? undefined : ""
      }
      data-rows-follow={isFolded || held.length === 0 ? undefined : ""}
    >
      <h3 className="board-lane-head" data-lane-head={lane.id}>
        <button
          type="button"
          className="board-lane-button"
          aria-expanded={!isFolded}
          onClick={() => {
            onToggleLane(lane.id);
          }}
        >
          <span className="board-chevron">
            <ChevronRightIcon size={12} />
          </span>
          {initiative !== undefined ? (
            <span className="board-lane-folder is-flag">
              <HueFlag hue={initiative.hue} />
            </span>
          ) : isNoPlace ? (
            <span className="board-lane-folder is-brand">
              <i className="board-lane-none" />
            </span>
          ) : outside === undefined ? (
            <span className="board-lane-folder">
              <FolderIcon size={14} />
            </span>
          ) : (
            <span className="board-lane-folder is-brand">
              <PluginMark pluginId={outside.pluginId} plugins={plugins} size={14} />
            </span>
          )}
          <span className="board-lane-words">
            <span className="board-lane-line">
              <span className="board-lane-name">{lane.name}</span>
              <span className="board-lane-total">{cardCountWithRows}</span>
              {isFolded &&
                held.map((each) => (
                  <HueFlag
                    key={each.id}
                    hue={each.hue}
                    title={each.name}
                    label={`Initiative ${each.name}`}
                  />
                ))}
            </span>
            {outside !== undefined && <OutsideFacts outside={outside} />}
            {failedCount > 0 && <span className="board-failed-count">{failedCount} failed</span>}
          </span>
        </button>
        {!isNoPlace && (
          <button
            type="button"
            className="board-lane-add"
            aria-label={`Add to ${lane.name}`}
            title={`Add to ${lane.name}`}
            onClick={() => {
              onAddTask(lane.id);
            }}
          >
            <PlusIcon size={14} />
          </button>
        )}
      </h3>
      {isFolded ? (
        <div
          className="board-fold-row"
          data-fold-row={lane.id}
          role="img"
          aria-label={describeFoldedCounts(cells)}
        >
          {cells.map((cell) => (
            <span key={cell.stage} className="board-fold-cell" data-stage={cell.stage}>
              {cell.dot !== null && (
                <i
                  className={cell.dot === "failed" ? "board-fold-dot is-failed" : "board-fold-dot"}
                />
              )}
              {cell.cardCountWithRows > 0 && <span>{cell.cardCountWithRows}</span>}
            </span>
          ))}
        </div>
      ) : (
        <div className="board-grid">
          {cells.map((cell) => (
            <BoardCell
              key={cell.stage}
              laneId={lane.id}
              laneName={lane.name}
              cell={cell}
              plugins={plugins}
              cardPlaces={outside?.cardPlaces}
              initiativeFlags={initiativeFlags}
              tabStop={tabStop}
              isStill={isStill}
              canWriteSummaries={canWriteSummaries}
              selectedIds={selectedIds}
              onToggleCell={onToggleCell}
              onToggleStack={onToggleStack}
              onPressCard={onPressCard}
              onFocusCard={onFocusCard}
            />
          ))}
        </div>
      )}
    </section>
  );
}
