import {
  NO_PROJECT_LANE_NAME,
  STAGE_NAMES,
  type CardMove,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";

/** The most characters of a title the undo line quotes. */
const MOST_TITLE_CHARACTERS = 32;

/** Returns the title cut to `MOST_TITLE_CHARACTERS`, with an ellipsis when it was cut. */
const shortenTitle = (title: string): string =>
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
