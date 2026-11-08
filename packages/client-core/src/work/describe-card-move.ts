import type { BoardStage, WorkCard } from "@hercule/contract";
import type { CardMove } from "./card-move";
import { STAGE_NAMES } from "./card-words";
import { NO_PROJECT_LANE_NAME, type WorkInitiative, type WorkProject } from "./lanes";
import { dropClosingFullStops } from "../text";
import { shortenTitle } from "./card-title";

/** Returns the name of an Initiative, or a plain word for one that is no longer listed. */
const nameInitiative = (initiativeId: string, initiatives: readonly WorkInitiative[]): string =>
  initiatives.find((initiative) => initiative.id === initiativeId)?.name ?? "another initiative";

/**
 * Returns the sentence the undo line shows when a move did not save and the
 * card went back. `reason` is the controller's message, or the error's.
 */
export const describeMoveFailure = (reason: string): string =>
  `The move did not save, so the card went back: ${dropClosingFullStops(reason)}. Try the move again.`;

/**
 * Returns the words for a move, in the past tense, for the undo line:
 * `Moved "Review PR" to In review`. The place named is what changed:
 *
 * - a new stage names the stage, and a new Project names the lane;
 * - a new Initiative names the Initiative, as a lane;
 * - a card taken off its Initiative says `out of Platform`;
 * - a card moved up or down in its own cell names the stage it stays in.
 *
 * `card` is the card as it stood before the move. A title longer than 32
 * characters is cut.
 */
export const describeCardMove = (
  card: WorkCard,
  move: CardMove,
  projects: readonly WorkProject[],
  initiatives: readonly WorkInitiative[],
): string => {
  const places: string[] = [];
  if (move.stage !== undefined && move.stage !== card.stage) places.push(STAGE_NAMES[move.stage]);
  if (move.projectId !== undefined && (move.projectId ?? undefined) !== card.projectId) {
    places.push(
      projects.find((project) => project.id === move.projectId)?.name ?? NO_PROJECT_LANE_NAME,
    );
  }
  if (typeof move.initiativeId === "string" && move.initiativeId !== card.initiativeId) {
    places.push(nameInitiative(move.initiativeId, initiatives));
  }
  const changes = [
    ...(places.length === 0 ? [] : [`to ${places.join(" in ")}`]),
    ...(move.initiativeId === null && card.initiativeId !== undefined
      ? [`out of ${nameInitiative(card.initiativeId, initiatives)}`]
      : []),
  ];
  const where = changes.length === 0 ? `in ${STAGE_NAMES[card.stage]}` : changes.join(" ");
  return `Moved "${shortenTitle(card.title)}" ${where}`;
};

/**
 * Returns the words for moving several cards together, in the past tense, for
 * the undo line: `Moved 3 Tasks to In review`. `moves` are the moves the cards
 * make and `stage` is where they land. The lane is named, as for one card,
 * only when a card changes Project: `Moved 3 Tasks to In review in Checkout`.
 * The same goes for an Initiative that a card joins: `... in Platform`.
 */
export const describeCardsMove = (
  moves: readonly CardMove[],
  stage: BoardStage,
  projects: readonly WorkProject[],
  initiatives: readonly WorkInitiative[],
): string => {
  const projectMove = moves.find((move) => move.projectId !== undefined);
  const initiativeMove = moves.find((move) => typeof move.initiativeId === "string");
  const lane =
    projectMove !== undefined
      ? ` in ${projects.find((project) => project.id === projectMove.projectId)?.name ?? NO_PROJECT_LANE_NAME}`
      : typeof initiativeMove?.initiativeId === "string"
        ? ` in ${nameInitiative(initiativeMove.initiativeId, initiatives)}`
        : "";
  return `Moved ${String(moves.length)} Tasks to ${STAGE_NAMES[stage]}${lane}`;
};
