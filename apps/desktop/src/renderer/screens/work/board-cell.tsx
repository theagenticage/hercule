import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  buildStackId,
  STAGE_NAMES,
  type ArrangedLaneCell,
  type CardInLane,
  type CardPlaces,
} from "@hercule/client-core/work";
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
 * A lead card of a stack stands in a `.board-stack` with the sheet under it
 * (`.board-stack-bar`, "2 pull requests"). Pressing the sheet calls
 * `onToggleStack` and opens the members as cards under the sheet, in place.
 * A stack with a question or a failure inside is open and its sheet is not a
 * button. Nothing stores a stack: the members are cards of the cell, and
 * leave the stack when the Task or the link changes.
 *
 * The cell carries `data-cell-id`, `data-lane-id` and `data-stage`, which drag
 * and keyboard code find it by. `tabStop` is the one card on the board that
 * Tab leads onto. `cardPlaces` holds, by Task id, what a card says when its
 * Task also stands in other lanes of the grouping. `selectedIds` are the
 * selected cards, which draw selected, and `onPressCard` is called when a card
 * is clicked.
 */
export function BoardCell({
  laneId,
  laneName,
  cell,
  plugins,
  cardPlaces,
  tabStop,
  isStill,
  canWriteSummaries,
  selectedIds,
  onToggleCell,
  onToggleStack,
  onPressCard,
  onFocusCard,
}: {
  readonly laneId: string;
  /** The name of the lane, which the cell's label ends with so a screen reader knows where it is. */
  readonly laneName: string;
  readonly cell: ArrangedLaneCell;
  readonly plugins: readonly PluginIdentity[];
  readonly cardPlaces: Readonly<Record<string, CardPlaces>> | undefined;
  readonly tabStop: CardInLane | null;
  readonly isStill: boolean;
  readonly canWriteSummaries: boolean;
  readonly onToggleCell: (cellId: string) => void;
  /** Called with the id of a stack (`buildStackId`) when its sheet is pressed. */
  readonly onToggleStack: (stackId: string) => void;
  readonly selectedIds: ReadonlySet<string>;
  readonly onPressCard: (card: WorkCard, keys: PressedKeys) => void;
  readonly onFocusCard: (at: CardInLane) => void;
}): JSX.Element {
  const { arrangement, stage, cellId } = cell;
  const isOpen = arrangement.foot === "fewer";
  const drawCard = (card: WorkCard): JSX.Element => (
    <WorkCardView
      key={card.id}
      card={card}
      laneId={laneId}
      plugins={plugins}
      alsoWords={cardPlaces?.[card.id]?.summary}
      alsoNames={cardPlaces?.[card.id]?.names.join(", ")}
      isTabStop={tabStop?.laneId === laneId && tabStop.cardId === card.id}
      isStill={isStill}
      canWriteSummaries={canWriteSummaries}
      isSelected={selectedIds.has(card.id)}
      isSelecting={selectedIds.size > 0}
      onPress={onPressCard}
      onFocus={onFocusCard}
    />
  );
  return (
    <div
      className="board-cell"
      role="group"
      aria-label={`${STAGE_NAMES[stage]}, ${String(cell.cardCount)} ${cell.cardCount === 1 ? "card" : "cards"}, in ${laneName}`}
      data-cell-id={cellId}
      data-lane-id={laneId}
      data-stage={stage}
    >
      {arrangement.cards.map((card) => {
        const stack = arrangement.stacks.get(card.id);
        if (stack === undefined) return drawCard(card);
        const stackId = buildStackId(laneId, card.id);
        const isStackOpen = cell.openStackLeadIds.has(card.id);
        return (
          <div key={card.id} className={isStackOpen ? "board-stack is-open" : "board-stack"}>
            {drawCard(card)}
            <button
              type="button"
              className="board-stack-bar"
              aria-expanded={isStackOpen}
              disabled={stack.opensItself}
              data-stack-bar={stackId}
              onClick={() => {
                onToggleStack(stackId);
              }}
            >
              <span>{stack.reason}</span>
              {!stack.opensItself && <ChevronDownIcon size={12} />}
            </button>
            {isStackOpen && (
              <div className="board-stack-members">
                {stack.members.map((member) => drawCard(member))}
              </div>
            )}
          </div>
        );
      })}
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
