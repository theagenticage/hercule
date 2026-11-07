import type { JSX } from "react";
import { STAGE_NAMES, type ArrangedLaneCell } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { WorkCardView, type PressedKeys } from "./work-card";

/**
 * Returns the words of the line under the cards of a cell: "13 more" or "3
 * landed" while it hides some, and "Show fewer" while the user has it open.
 */
const describeFoot = (cell: ArrangedLaneCell): string => {
  switch (cell.arrangement.foot) {
    case "more":
      return `${String(cell.arrangement.hiddenCards.length)} more`;
    case "landed":
      return `${String(cell.arrangement.hiddenCards.length)} landed`;
    case "fewer":
    case "none":
      return "Show fewer";
  }
};

/**
 * Renders one cell of the board: the cards of one stage in one lane, top to
 * bottom, and under them the line that opens the rest in place ("13 more",
 * "3 landed") or closes it again ("Show fewer").
 *
 * The cell carries `data-cell-id`, `data-lane-id` and `data-stage`, which drag
 * and keyboard code find it by. `tabStopCardId` is the one card on the board
 * that Tab leads onto. `selectedIds` are the selected cards, which draw
 * selected, and `onPressCard` is called when a card is clicked.
 */
export function BoardCell({
  laneId,
  laneName,
  cell,
  tabStopCardId,
  isStill,
  canWriteSummaries,
  selectedIds,
  onToggleCell,
  onPressCard,
  onFocusCard,
}: {
  readonly laneId: string;
  /** The name of the lane, which the cell's label ends with so a screen reader knows where it is. */
  readonly laneName: string;
  readonly cell: ArrangedLaneCell;
  readonly tabStopCardId: string | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly onToggleCell: (cellId: string) => void;
  readonly selectedIds: ReadonlySet<string>;
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (cardId: string) => void;
}): JSX.Element {
  const { arrangement, stage, cellId } = cell;
  const isOpen = arrangement.foot === "fewer";
  return (
    <div
      className="board-cell"
      role="group"
      aria-label={`${STAGE_NAMES[stage]}, ${String(cell.cardCount)} ${cell.cardCount === 1 ? "card" : "cards"}, in ${laneName}`}
      data-cell-id={cellId}
      data-lane-id={laneId}
      data-stage={stage}
    >
      {arrangement.cards.map((card) => (
        <WorkCardView
          key={card.id}
          card={card}
          isTabStop={card.id === tabStopCardId}
          isStill={isStill}
          canWriteSummaries={canWriteSummaries}
          isSelected={selectedIds.has(card.id)}
          isSelecting={selectedIds.size > 0}
          onPress={onPressCard}
          onFocus={onFocusCard}
        />
      ))}
      {arrangement.foot !== "none" && (
        <button
          type="button"
          className="board-more"
          aria-expanded={isOpen}
          data-more-cell-id={cellId}
          onClick={() => {
            onToggleCell(cellId);
          }}
        >
          <span>{describeFoot(cell)}</span>
          <ChevronDownIcon size={12} />
        </button>
      )}
    </div>
  );
}
