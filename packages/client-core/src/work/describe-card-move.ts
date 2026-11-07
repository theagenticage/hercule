import type { BoardStage, WorkCard } from "@hercule/contract";
import type { CardMove } from "./card-move";
import { STAGE_NAMES } from "./card-words";
import { NO_PROJECT_LANE_NAME, type WorkProject } from "./lanes";

/** The most characters of a title the undo line quotes. */
const MOST_TITLE_CHARACTERS = 32;

/** Returns the title cut to `MOST_TITLE_CHARACTERS`, with an ellipsis when it was cut. */
export const shortenTitle = (title: string): string =>
  title.length <= MOST_TITLE_CHARACTERS ? title : `${title.slice(0, MOST_TITLE_CHARACTERS - 1)}…`;

/**
 * Returns the words for a move, in the past tense, for the undo line:
 * `Moved "Review PR" to In review`. The place named is what changed:
 *
 * - a new stage names the stage, and a new Project names the lane;
 * - a card moved up or down in its own cell names the stage it stays in.
 *
 * `card` is the card as it stood before the move. A title longer than 32
 * characters is cut.
 */
export const describeCardMove = (
  card: WorkCard,
  move: CardMove,
  projects: readonly WorkProject[],
): string => {
  const places: string[] = [];
  if (move.stage !== undefined && move.stage !== card.stage) places.push(STAGE_NAMES[move.stage]);
  if (move.projectId !== undefined && (move.projectId ?? undefined) !== card.projectId) {
    places.push(
      projects.find((project) => project.id === move.projectId)?.name ?? NO_PROJECT_LANE_NAME,
    );
  }
  const where = places.length === 0 ? `in ${STAGE_NAMES[card.stage]}` : `to ${places.join(" in ")}`;
  return `Moved "${shortenTitle(card.title)}" ${where}`;
};

/**
 * Returns the words for moving several cards together, in the past tense, for
 * the undo line: `Moved 3 Tasks to In review`. `moves` are the moves the cards
 * make and `stage` is where they land. The lane is named, as for one card,
 * only when a card changes Project: `Moved 3 Tasks to In review in Checkout`.
 */
export const describeCardsMove = (
  moves: readonly CardMove[],
  stage: BoardStage,
  projects: readonly WorkProject[],
): string => {
  const change = moves.find((move) => move.projectId !== undefined);
  const lane =
    change === undefined
      ? ""
      : ` in ${projects.find((project) => project.id === change.projectId)?.name ?? NO_PROJECT_LANE_NAME}`;
  return `Moved ${String(moves.length)} Tasks to ${STAGE_NAMES[stage]}${lane}`;
};
