import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  isTopInitiativeRow,
  listDrawnLanes,
  listLaneInitiatives,
  type ArrangedLane,
  type CardInLane,
  type WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { BoardLane } from "./board-lane";
import { InitiativeBlock, InitiativeRow, NotInInitiativeHeading } from "./initiative-row";
import type { PressedKeys } from "./work-card";

/** Returns whether `arrangedLane` is a row drawn under the lane it follows. */
const isRowUnderLane = (arrangedLane: ArrangedLane | undefined): boolean =>
  arrangedLane?.lane.initiative?.isRow === true &&
  arrangedLane.lane.initiative.underLaneId !== undefined;

/**
 * Renders the lanes of the board, with the Initiative rows among them, in the
 * order `arrangedLanes` has them:
 *
 * - On top: the rows come first, in the block under the "Initiatives" heading
 *   (nothing but the heading while `isBlockFolded`; the heading counts all the rows). When lanes follow, the
 *   heading "Not in an initiative" goes over them.
 * - In lanes: each row follows the lane it stands under, as its next sibling,
 *   and is drawn there; under a folded lane it is not drawn.
 * - With no row (Group by Initiative, an outside place, or no Initiative), the
 *   lanes alone: the board as it was before Initiatives.
 *
 * `factsByInitiativeId` holds the words under each row's name. It is
 * presentational: it reads nothing and tells the screen what the user pressed.
 */
export function BoardBody({
  arrangedLanes,
  plugins,
  initiativeFlags,
  factsByInitiativeId,
  tabStop,
  isStill,
  canWriteSummaries,
  selectedIds,
  isBlockFolded,
  onToggleBlock,
  onToggleLane,
  onToggleRow,
  onEditInitiative,
  onPressBead,
  onToggleCell,
  onToggleStack,
  onAddTask,
  onPressCard,
  onFocusCard,
}: {
  /** Every lane and row, including the rows that a fold hides, which this leaves undrawn. */
  readonly arrangedLanes: readonly ArrangedLane[];
  readonly plugins: readonly PluginIdentity[];
  /** The Initiatives whose small flag a card draws, by id. Absent where no card draws one. */
  readonly initiativeFlags: ReadonlyMap<string, WorkInitiative> | undefined;
  /** The words under the name of each row, by the id of its Initiative. */
  readonly factsByInitiativeId: ReadonlyMap<string, string | null>;
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly selectedIds: ReadonlySet<string>;
  /** Whether the block of rows On top is folded. */
  readonly isBlockFolded: boolean;
  readonly onToggleBlock: () => void;
  readonly onToggleLane: (laneId: string) => void;
  /** Called with the lane id of the row whose head was pressed. It may be the function `onToggleLane` is. */
  readonly onToggleRow: (laneId: string) => void;
  readonly onEditInitiative: (initiativeId: string) => void;
  /** Called with the id of the Task whose bead was pressed. */
  readonly onPressBead: (taskId: string) => void;
  readonly onToggleCell: (cellId: string) => void;
  readonly onToggleStack: (stackId: string) => void;
  readonly onAddTask: (laneId: string) => void;
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const drawRow = (each: ArrangedLane, isLastUnderLane: boolean): JSX.Element => (
    <InitiativeRow
      key={each.lane.id}
      arrangedLane={each}
      isLastUnderLane={isLastUnderLane}
      facts={factsByInitiativeId.get(each.lane.initiative?.initiativeId ?? "") ?? null}
      plugins={plugins}
      tabStop={tabStop}
      isStill={isStill}
      canWriteSummaries={canWriteSummaries}
      selectedIds={selectedIds}
      onToggleRow={onToggleRow}
      onEditInitiative={onEditInitiative}
      onPressBead={onPressBead}
      onToggleCell={onToggleCell}
      onToggleStack={onToggleStack}
      onPressCard={onPressCard}
      onFocusCard={onFocusCard}
    />
  );
  const drawLane = (each: ArrangedLane): JSX.Element => (
    <BoardLane
      key={each.lane.id}
      arrangedLane={each}
      plugins={plugins}
      initiativeFlags={initiativeFlags}
      heldInitiatives={listLaneInitiatives(arrangedLanes, each.lane.id)}
      tabStop={tabStop}
      isStill={isStill}
      canWriteSummaries={canWriteSummaries}
      selectedIds={selectedIds}
      onToggleLane={onToggleLane}
      onToggleCell={onToggleCell}
      onToggleStack={onToggleStack}
      onAddTask={onAddTask}
      onPressCard={onPressCard}
      onFocusCard={onFocusCard}
    />
  );
  // The same list the screen walks, selects and drops on: a folded lane hides its rows and draws
  // a flag for each instead (`heldInitiatives`), and a folded block hides all the rows On top.
  const drawnLanes = listDrawnLanes(arrangedLanes, isBlockFolded);
  const topRowCount = arrangedLanes.filter(({ lane }) => isTopInitiativeRow(lane)).length;
  const rest = drawnLanes.filter(({ lane }) => !isTopInitiativeRow(lane));
  return (
    <div className="board-lanes">
      {topRowCount > 0 && (
        <InitiativeBlock count={topRowCount} isFolded={isBlockFolded} onToggle={onToggleBlock}>
          {drawnLanes
            .filter(({ lane }) => isTopInitiativeRow(lane))
            .map((each) => drawRow(each, false))}
        </InitiativeBlock>
      )}
      {topRowCount > 0 && rest.length > 0 && <NotInInitiativeHeading />}
      {rest.map((each, index) =>
        each.lane.initiative?.isRow === true
          ? drawRow(each, !isRowUnderLane(rest[index + 1]))
          : drawLane(each),
      )}
    </div>
  );
}
