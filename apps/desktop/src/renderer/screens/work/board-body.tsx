import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type {
  ArrangedBoard,
  ArrangedLane,
  CardInLane,
  WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { BoardLane } from "./board-lane";
import { InitiativeBlock, InitiativeRow, NotInInitiativeHeading } from "./initiative-row";
import type { PressedKeys } from "./work-card";

/**
 * Renders the board `arrangement` describes, which it only draws:
 *
 * - On top: the rows of `arrangement.block` come first, under the "Initiatives"
 *   heading (nothing but the heading while the block is folded; the heading
 *   counts all the rows). When lanes follow, the heading "Not in an initiative"
 *   goes over them.
 * - In lanes: each lane is followed by its own rows, drawn there; a folded lane
 *   does not draw them.
 * - With no row (Group by Initiative, an outside place, or no Initiative), the
 *   lanes alone: the board as it was before Initiatives.
 *
 * It is presentational: it reads nothing and tells the screen what the user
 * pressed.
 */
export function BoardBody({
  arrangement,
  plugins,
  initiativeFlags,
  tabStop,
  isStill,
  canWriteSummaries,
  selectedIds,
  onToggleBlock,
  onToggleFold,
  onEditInitiative,
  onPressBead,
  onToggleCell,
  onToggleStack,
  onAddTask,
  onPressCard,
  onFocusCard,
}: {
  /** The board: its block of rows On top and its lanes, each with the rows under it. */
  readonly arrangement: Pick<ArrangedBoard, "block" | "lanes" | "factsByInitiativeId">;
  readonly plugins: readonly PluginIdentity[];
  /** The Initiatives whose small flag a card draws, by id. Absent where no card draws one. */
  readonly initiativeFlags: ReadonlyMap<string, WorkInitiative> | undefined;
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleBlock: () => void;
  /** Called with the id of the lane, or of the Initiative row, whose head was pressed. */
  readonly onToggleFold: (laneId: string) => void;
  readonly onEditInitiative: (initiativeId: string) => void;
  /** Called with the id of the Task whose bead was pressed. */
  readonly onPressBead: (taskId: string) => void;
  readonly onToggleCell: (cellId: string) => void;
  readonly onToggleStack: (stackId: string) => void;
  readonly onAddTask: (laneId: string) => void;
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const drawRow = (
    each: ArrangedLane,
    place: { readonly isUnderLane: boolean; readonly isLastUnderLane: boolean },
  ): JSX.Element => (
    <InitiativeRow
      key={each.lane.id}
      arrangedLane={each}
      isUnderLane={place.isUnderLane}
      isLastUnderLane={place.isLastUnderLane}
      facts={arrangement.factsByInitiativeId.get(each.lane.initiative?.initiativeId ?? "") ?? null}
      plugins={plugins}
      tabStop={tabStop}
      isStill={isStill}
      canWriteSummaries={canWriteSummaries}
      selectedIds={selectedIds}
      onToggleRow={onToggleFold}
      onEditInitiative={onEditInitiative}
      onPressBead={onPressBead}
      onToggleCell={onToggleCell}
      onToggleStack={onToggleStack}
      onPressCard={onPressCard}
      onFocusCard={onFocusCard}
    />
  );
  const { block, lanes } = arrangement;
  return (
    <div className="board-lanes">
      {block !== null && (
        <InitiativeBlock
          count={block.rows.length}
          isFolded={block.isFolded}
          onToggle={onToggleBlock}
        >
          {block.isFolded
            ? null
            : block.rows.map((row) => drawRow(row, { isUnderLane: false, isLastUnderLane: false }))}
        </InitiativeBlock>
      )}
      {block !== null && lanes.length > 0 && <NotInInitiativeHeading />}
      {lanes.flatMap((each) => [
        <BoardLane
          key={each.lane.id}
          arrangedLane={each}
          plugins={plugins}
          initiativeFlags={initiativeFlags}
          heldInitiatives={each.heldInitiatives}
          tabStop={tabStop}
          isStill={isStill}
          canWriteSummaries={canWriteSummaries}
          selectedIds={selectedIds}
          onToggleLane={onToggleFold}
          onToggleCell={onToggleCell}
          onToggleStack={onToggleStack}
          onAddTask={onAddTask}
          onPressCard={onPressCard}
          onFocusCard={onFocusCard}
        />,
        ...(each.isFolded
          ? []
          : each.rows.map((row, index) =>
              drawRow(row, { isUnderLane: true, isLastUnderLane: index === each.rows.length - 1 }),
            )),
      ])}
    </div>
  );
}
