import { useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  STAGE_NAMES,
  type ArrangedLane,
  type CardInLane,
  type CardState,
  type InitiativeBead,
  type InitiativeLineCell,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ComposeIcon } from "../../icons/compose";
import { buildHueStyle, HueFlag, StatusShape } from "../desk";
import { BoardCell } from "./board-cell";
import type { PressedKeys } from "./work-card";
import "./initiatives.css";

/** The selector of the beads of a line that are buttons. A ring for a Done Task is not one of them. */
const BEAD_SELECTOR = "[data-bead-task-id]";

/** What a bead of each kind adds to its Task's title and stage. An open or landed Task adds nothing. */
const BEAD_STATE_WORDS: Readonly<Partial<Record<CardState, string>>> = {
  failed: "failed",
  question: "has a question",
  blocked: "blocked",
};

/** Returns what a screen reader says for the bead of `card`, such as "Retry policy, Building, failed". */
const describeBead = (card: WorkCard, kind: CardState): string =>
  [card.title, STAGE_NAMES[card.stage], BEAD_STATE_WORDS[kind]]
    .filter((part) => part !== undefined)
    .join(", ");

/**
 * Renders one bead: a button that opens its Task, or, for a Done Task that has
 * no card, a ring that is no button. A failed bead is the app's failed mark at
 * 13px; every other kind is a 9px dot drawn by `initiatives.css` from
 * `data-kind`.
 */
function Bead({
  bead,
  card,
  isTabStop,
  onPress,
}: {
  readonly bead: InitiativeBead;
  readonly card: WorkCard | undefined;
  readonly isTabStop: boolean;
  readonly onPress: (taskId: string) => void;
}): JSX.Element {
  const mark = bead.kind === "failed" ? <StatusShape shape="cross" tone="bad" size={13} /> : null;
  if (bead.taskId === null || card === undefined) {
    return <i className="initiative-bead" data-kind={bead.kind} />;
  }
  const { taskId } = bead;
  return (
    <button
      type="button"
      className="initiative-bead"
      data-kind={bead.kind}
      data-bead-task-id={taskId}
      aria-label={describeBead(card, bead.kind)}
      tabIndex={isTabStop ? 0 : -1}
      onClick={() => {
        onPress(taskId);
      }}
    >
      {mark}
    </button>
  );
}

/** Renders the beads of one stage of a line, with the line's bright part ending after the last one when this is the reach cell. */
function LineCell({
  cell,
  column,
  isReachEnd,
  cardsById,
  tabStopTaskId,
  onPressBead,
}: {
  readonly cell: InitiativeLineCell;
  /** The 1-based column of the board's grid the cell stands in, so its beads sit under their stage. */
  readonly column: number;
  readonly isReachEnd: boolean;
  readonly cardsById: ReadonlyMap<string, WorkCard>;
  readonly tabStopTaskId: string | null;
  readonly onPressBead: (taskId: string) => void;
}): JSX.Element {
  return (
    <span
      className={cell.isTally ? "initiative-line-cell is-tally" : "initiative-line-cell"}
      data-stage={cell.stage}
      style={{ gridColumn: column }}
    >
      {cell.beads.length > 0 && (
        <span className={isReachEnd ? "initiative-beads is-reach-end" : "initiative-beads"}>
          {cell.beads.map((bead, index) => (
            <Bead
              // A Done ring has no id, and rings never reorder, so their index is a stable key.
              key={bead.taskId ?? `ring-${String(index)}`}
              bead={bead}
              card={bead.taskId === null ? undefined : cardsById.get(bead.taskId)}
              isTabStop={bead.taskId !== null && bead.taskId === tabStopTaskId}
              onPress={onPressBead}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Renders the folded line of a row: a faint line across the stages, bright
 * from the start to the last bead, with one bead for each Task under its stage.
 *
 * The line is one tab stop. Left and right arrows, Home and End walk its
 * beads, and Return on a bead opens its Task.
 */
function InitiativeLine({
  arrangedLane,
  onPressBead,
}: {
  readonly arrangedLane: ArrangedLane;
  readonly onPressBead: (taskId: string) => void;
}): JSX.Element | null {
  const { line, lane } = arrangedLane;
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  if (line === undefined) return null;
  const cardsById = new Map(
    lane.cells.flatMap(({ cards }) => cards).map((card) => [card.id, card]),
  );
  const realTaskIds = line.cells.flatMap(({ beads }) =>
    beads.flatMap((bead) => (bead.taskId === null ? [] : [bead.taskId])),
  );
  const tabStopTaskId =
    focusedTaskId !== null && realTaskIds.includes(focusedTaskId)
      ? focusedTaskId
      : (realTaskIds[0] ?? null);
  const taskCount = line.cells.reduce((sum, cell) => sum + cell.beadCount, 0);

  const walkBeads = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Shift with an arrow moves the Task of the bead a stage (`useBeadSlide`), which is not a walk.
    if (event.shiftKey || event.defaultPrevented) return;
    const beads = [...event.currentTarget.querySelectorAll<HTMLElement>(BEAD_SELECTOR)];
    const at = beads.findIndex((bead) => bead === document.activeElement);
    const target =
      event.key === "ArrowRight"
        ? beads[Math.min(at + 1, beads.length - 1)]
        : event.key === "ArrowLeft"
          ? beads[Math.max(at - 1, 0)]
          : event.key === "Home"
            ? beads[0]
            : event.key === "End"
              ? beads.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div
      className="initiative-line"
      role="group"
      aria-label={`${String(taskCount)} ${taskCount === 1 ? "Task" : "Tasks"}, folded`}
      data-fold-row={lane.id}
      onKeyDown={walkBeads}
      onFocus={(event) => {
        const taskId = event.target.getAttribute("data-bead-task-id");
        if (taskId !== null) setFocusedTaskId(taskId);
      }}
    >
      {line.reachStageIndex !== null && line.reachStageIndex > 0 && (
        <i
          className="initiative-reach"
          style={{ gridColumn: `1 / span ${String(line.reachStageIndex)}` }}
        />
      )}
      {line.cells.map((cell, index) => (
        <LineCell
          key={cell.stage}
          cell={cell}
          column={index + 1}
          isReachEnd={index === line.reachStageIndex}
          cardsById={cardsById}
          tabStopTaskId={tabStopTaskId}
          onPressBead={onPressBead}
        />
      ))}
    </div>
  );
}

/**
 * Renders one Initiative row of the board: a head and under it either its
 * line, folded, or a band of its cards, open.
 *
 * - The head is a button that opens the row in place or folds it
 *   (`aria-expanded`): a chevron, the flag in the Initiative's colour, its
 *   name, `facts` in small type under it (beside it with bands), and "1 failed"
 *   in ink when a card failed. An edit button at the head's right end shows on
 *   hover and on keyboard focus and calls `onEditInitiative`.
 * - Folded, the line has one bead for each Task. A bead is a button that calls
 *   `onPressBead` with its Task's id. A Done Task is a ring with no button.
 * - Open, the band holds the row's five cells, drawn by `BoardCell` as a lane
 *   draws them, with a 2px bar in the Initiative's colour down its left.
 *
 * The section carries `data-lane-id`, the head `data-lane-head`, and the
 * folded line `data-fold-row`, as a lane does, which motion and keyboard code
 * find them by. `data-place` is `lane` for a row drawn under its Project's
 * lane and `top` for one drawn above the lanes.
 */
export function InitiativeRow({
  arrangedLane,
  facts,
  plugins,
  tabStop,
  isStill,
  canWriteSummaries,
  selectedIds,
  onToggleRow,
  onEditInitiative,
  onPressBead,
  onToggleCell,
  onToggleStack,
  onPressCard,
  onFocusCard,
}: {
  /** A lane whose `initiative` is set and whose `isRow` is true. */
  readonly arrangedLane: ArrangedLane;
  /** The small facts under the name (`describeInitiativeFacts`), or `null` for none. */
  readonly facts: string | null;
  readonly plugins: readonly PluginIdentity[];
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  /** The ids of the selected cards, which draw selected. */
  readonly selectedIds: ReadonlySet<string>;
  /** Called with the row's lane id when its head is pressed. */
  readonly onToggleRow: (laneId: string) => void;
  readonly onEditInitiative: (initiativeId: string) => void;
  /** Called with the id of a Task when its bead is pressed. */
  readonly onPressBead: (taskId: string) => void;
  readonly onToggleCell: (cellId: string) => void;
  readonly onToggleStack: (stackId: string) => void;
  /** Called with the card and the keys held when a card is clicked. */
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const { lane, isFolded, failedCount, cells } = arrangedLane;
  const { initiative } = lane;
  if (initiative === undefined) throw new Error(`The lane ${lane.id} is not an Initiative`);
  return (
    <section
      className={isFolded ? "initiative-row" : "initiative-row is-open"}
      style={buildHueStyle(initiative.hue)}
      data-lane-id={lane.id}
      data-place={initiative.underLaneId === undefined ? "top" : "lane"}
    >
      <h4 className="initiative-head" data-lane-head={lane.id}>
        <button
          type="button"
          className="initiative-toggle"
          aria-expanded={!isFolded}
          onClick={() => {
            onToggleRow(lane.id);
          }}
        >
          <span className="initiative-chevron">
            <ChevronRightIcon size={12} />
          </span>
          <HueFlag hue={initiative.hue} />
          <span className="initiative-words">
            <span className="initiative-name">{lane.name}</span>
            {facts !== null && <small className="initiative-facts">{facts}</small>}
          </span>
          {failedCount > 0 && <span className="board-failed-count">{failedCount} failed</span>}
        </button>
        <button
          type="button"
          className="initiative-edit"
          aria-label={`Edit ${lane.name}`}
          title={`Edit ${lane.name}`}
          onClick={() => {
            onEditInitiative(initiative.initiativeId);
          }}
        >
          <ComposeIcon size={14} />
        </button>
      </h4>
      {isFolded ? (
        <InitiativeLine arrangedLane={arrangedLane} onPressBead={onPressBead} />
      ) : (
        <div className="initiative-band">
          <div className="board-grid">
            {cells.map((cell) => (
              <BoardCell
                key={cell.stage}
                laneId={lane.id}
                laneName={lane.name}
                cell={cell}
                plugins={plugins}
                cardPlaces={undefined}
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
        </div>
      )}
    </section>
  );
}

/**
 * Renders the block of rows On top: the heading "Initiatives" with how many
 * there are, which folds the whole block for a day with many, and under it
 * `children`, the rows. Folded, only the heading stays.
 */
export function InitiativeBlock({
  count,
  isFolded,
  onToggle,
  children,
}: {
  readonly count: number;
  readonly isFolded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="initiative-block">
      <h3 className="initiative-title">
        <button
          type="button"
          className="initiative-block-button"
          aria-expanded={!isFolded}
          onClick={onToggle}
        >
          <span className="initiative-chevron">
            <ChevronRightIcon size={12} />
          </span>
          Initiatives <small>{count}</small>
        </button>
      </h3>
      {!isFolded && <div className="initiative-list">{children}</div>}
    </section>
  );
}

/** Renders the heading over the lanes that hold what is in no Initiative, when the rows are On top. */
export function NotInInitiativeHeading(): JSX.Element {
  return <h3 className="initiative-title">Not in an initiative</h3>;
}
