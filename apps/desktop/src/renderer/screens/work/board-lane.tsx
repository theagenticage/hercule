import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { buildRelationProgress } from "@hercule/client-core/desk";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { FolderIcon } from "../../icons/folder";
import { PlusIcon } from "../../icons/plus";
import type { WorkCard } from "@hercule/contract";
import {
  STAGE_NAMES,
  type ArrangedLane,
  type ArrangedLaneCell,
  type CardInLane,
  type OutsideLane,
} from "@hercule/client-core/work";
import { PluginMark } from "../../marks";
import { ProgressBar } from "../desk";
import { BoardCell } from "./board-cell";

/**
 * Returns what the line of counts of a folded lane says to a screen reader,
 * such as "Exploring 2, Building 1 with a failure". The sighted board shows the
 * counts under each stage and a coloured dot, which words cannot read.
 */
const describeFoldedCounts = (cells: readonly ArrangedLaneCell[]): string => {
  const words = cells
    .filter((cell) => cell.cardCount > 0)
    .map((cell) => {
      const dot =
        cell.dot === "failed"
          ? " with a failure"
          : cell.dot === "question"
            ? " with a question"
            : "";
      return `${STAGE_NAMES[cell.stage]} ${String(cell.cardCount)}${dot}`;
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
 *   beside it adds a Task to this lane.
 * - The lane of an outside place, such as a repository, has the source's
 *   mark in place of the folder and says what the place says about itself
 *   under its name (`OutsideFacts`). The lane that collects what has no such
 *   place has a ring in place of the folder and no `+`.
 * - A folded lane shows a 6px dot under a stage that holds a card with a
 *   question (marigold) or a failure (tomato).
 *
 * The section carries `data-lane-id`, the head `data-lane-head`, and the line
 * of counts `data-fold-row`, which motion and keyboard code find them by.
 */
export function BoardLane({
  arrangedLane,
  plugins,
  tabStop,
  isStill,
  onToggleLane,
  onToggleCell,
  onAddTask,
  onOpenCard,
  onFocusCard,
}: {
  readonly arrangedLane: ArrangedLane;
  readonly plugins: readonly PluginIdentity[];
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly onToggleLane: (laneId: string) => void;
  readonly onToggleCell: (cellId: string) => void;
  readonly onAddTask: (laneId: string) => void;
  readonly onOpenCard: (card: WorkCard) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const { lane, isFolded, failedCount, cells } = arrangedLane;
  const { outside } = lane;
  const total = cells.reduce((sum, cell) => sum + cell.cardCount, 0);
  return (
    <section className={isFolded ? "board-lane is-folded" : "board-lane"} data-lane-id={lane.id}>
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
          {outside === undefined ? (
            <span className="board-lane-folder">
              <FolderIcon size={14} />
            </span>
          ) : outside.pluginId === null ? (
            <span className="board-lane-folder is-brand">
              <i className="board-lane-none" />
            </span>
          ) : (
            <span className="board-lane-folder is-brand">
              <PluginMark pluginId={outside.pluginId} plugins={plugins} size={14} />
            </span>
          )}
          <span className="board-lane-words">
            <span className="board-lane-line">
              <span className="board-lane-name">{lane.name}</span>
              <span className="board-lane-total">{total}</span>
            </span>
            {outside !== undefined && <OutsideFacts outside={outside} />}
            {failedCount > 0 && <span className="board-failed-count">{failedCount} failed</span>}
          </span>
        </button>
        {outside?.pluginId !== null && (
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
              {cell.cardCount > 0 && <span>{cell.cardCount}</span>}
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
              tabStop={tabStop}
              isStill={isStill}
              onToggleCell={onToggleCell}
              onOpenCard={onOpenCard}
              onFocusCard={onFocusCard}
            />
          ))}
        </div>
      )}
    </section>
  );
}
