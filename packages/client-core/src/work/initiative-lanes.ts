/**
 * Initiatives on the Work board. A Task belongs to at most one Initiative, and
 * the board draws it in exactly one place:
 *
 * - on the Initiative, when the Initiative is in the list the screen passes
 *   (the open ones);
 * - in its lane, in any other case. A Task whose Initiative is closed or
 *   deleted has no row to stand on, so it is back in its lane, and it keeps
 *   its `initiativeId`.
 *
 * An Initiative is drawn as a `WorkLane` whose `initiative` field is set, so
 * its cells walk, drop and animate like the cells of any other lane. Group by
 * Project draws Initiatives as rows (`groupBoardByProject`); Group by
 * Initiative draws one lane for each (`groupBoardByInitiative`); every other
 * grouping draws none, and its cards show a small flag instead
 * (`findCardInitiativeFlag`).
 */
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { PROJECT_FACET_ID } from "./facets";
import {
  buildLane,
  buildLanes,
  chooseProjectLaneId,
  type InitiativeLane,
  type WorkInitiative,
  type WorkLane,
  type WorkProject,
} from "./lanes";

/** The id of the lane for the Tasks that are on no listed Initiative, in Group by Initiative. */
export const NO_INITIATIVE_LANE_ID = "none:initiative";

/** The name of the lane for the Tasks that are on no listed Initiative, in Group by Initiative. */
export const NO_INITIATIVE_LANE_NAME = "Not in an initiative";

/**
 * Where Group by Project draws the Initiative rows: `top`, all together above
 * the lanes, or `lanes`, each under the lane of its Project.
 */
export type InitiativePlace = "top" | "lanes";

/** What the board is told about the user's view of Initiatives. */
export interface InitiativeView {
  readonly place: InitiativePlace;
  /** Whether a filter or a Find text is on. The cards passed are then the ones that match. */
  readonly isFiltering: boolean;
}

/** The part of a board that Initiative lanes read. */
type InitiativeBoard = Pick<WorkBoard, "cards" | "initiativeDoneCounts">;

/**
 * Returns the id of the row for an Initiative. It differs from the id of its
 * lane in Group by Initiative, so that the cells of the two never share an id
 * (`buildCellId`) when the user opens one in each.
 */
const buildInitiativeRowId = (initiativeId: string): string => `initiative-row:${initiativeId}`;

const buildInitiativeLaneId = (initiativeId: string): string => `initiative:${initiativeId}`;

/** The cards of each listed Initiative, and the cards that stand on none of them, each in board order. */
interface InitiativePartition {
  readonly byInitiative: ReadonlyMap<string, readonly WorkCard[]>;
  readonly loose: readonly WorkCard[];
}

/** Returns where each card stands: on the listed Initiative it names, or loose. */
const partitionByInitiative = (
  cards: readonly WorkCard[],
  initiatives: readonly WorkInitiative[],
): InitiativePartition => {
  const byInitiative = new Map<string, WorkCard[]>(
    initiatives.map((initiative) => [initiative.id, []]),
  );
  const loose: WorkCard[] = [];
  for (const card of cards) {
    const onInitiative =
      card.initiativeId === undefined ? undefined : byInitiative.get(card.initiativeId);
    if (onInitiative === undefined) loose.push(card);
    else onInitiative.push(card);
  }
  return { byInitiative, loose };
};

/**
 * Returns the lanes of Group by Project: the Project lanes of `buildLanes`,
 * with an Initiative row for each Initiative in `initiatives`, in the order
 * they are drawn. A card on a listed Initiative is on its row and in no lane;
 * every other card is in its Project lane.
 *
 * - `top`: all rows first, in the order of `initiatives`, then the lanes of
 *   the cards on no Initiative. A row says its Project's name in its facts
 *   (`InitiativeLane.projectName`).
 * - `lanes`: each lane is followed by the rows of the Initiatives whose
 *   Project it is. An Initiative with no Project, or a Project that is not in
 *   `projects`, draws in the "No project" lane. A lane with no loose card is
 *   still drawn when it holds a row.
 * - An Initiative with no Task still has its row, so the user can drop the
 *   first card on it. While `view.isFiltering`, a row with no card left, and a
 *   lane with nothing left, are dropped: a filter is a question about Tasks.
 *
 * With no Initiative it returns what `buildLanes` returns. Call it with the
 * cards the filter leaves, to draw the board. `board.initiativeDoneCounts`
 * gives the rings at the end of each row's Landed cell.
 */
export const groupBoardByProject = (
  board: InitiativeBoard,
  projects: readonly WorkProject[],
  initiatives: readonly WorkInitiative[],
  view: InitiativeView,
): readonly WorkLane[] => {
  const { byInitiative, loose } = partitionByInitiative(board.cards, initiatives);
  const shown = initiatives.filter(
    (initiative) => !view.isFiltering || (byInitiative.get(initiative.id)?.length ?? 0) > 0,
  );
  const buildRow = (
    initiative: WorkInitiative,
    where: Pick<InitiativeLane, "underLaneId" | "projectName">,
  ): WorkLane =>
    buildLane(
      buildInitiativeRowId(initiative.id),
      initiative.name,
      null,
      byInitiative.get(initiative.id) ?? [],
      undefined,
      {
        initiativeId: initiative.id,
        hue: initiative.hue,
        isRow: true,
        doneRingCount: view.isFiltering ? 0 : (board.initiativeDoneCounts[initiative.id] ?? 0),
        ...where,
      },
    );
  if (view.place === "top") {
    const rows = shown.map((initiative) => {
      const projectName = projects.find((project) => project.id === initiative.projectId)?.name;
      return buildRow(initiative, projectName === undefined ? {} : { projectName });
    });
    return [...rows, ...buildLanes({ cards: loose }, projects)];
  }
  const projectIds = new Set(projects.map((project) => project.id));
  const laneIdOf = (initiative: WorkInitiative): string =>
    chooseProjectLaneId(initiative.projectId, projectIds);
  const lanes = buildLanes({ cards: loose }, projects, new Set(shown.map(laneIdOf)));
  return lanes.flatMap((lane) => [
    lane,
    ...shown
      .filter((initiative) => laneIdOf(initiative) === lane.id)
      .map((initiative) => buildRow(initiative, { underLaneId: lane.id })),
  ]);
};

/**
 * Returns the lanes of Group by Initiative: one lane for each Initiative in
 * `initiatives`, in that order, then the lane "Not in an initiative" for the
 * cards on none of them. A card on a closed Initiative is in the last lane.
 * These lanes are ordinary lanes, not rows: they fold like a Project lane.
 *
 * An Initiative with no Task still has its lane, and so does "Not in an
 * initiative" once an Initiative exists, so a drop can put a card on either.
 * While `view.isFiltering`, a lane with no card left is dropped.
 */
export const groupBoardByInitiative = (
  board: Pick<WorkBoard, "cards">,
  initiatives: readonly WorkInitiative[],
  view: Pick<InitiativeView, "isFiltering">,
): readonly WorkLane[] => {
  const { byInitiative, loose } = partitionByInitiative(board.cards, initiatives);
  const lanes = initiatives.flatMap((initiative) => {
    const cards = byInitiative.get(initiative.id) ?? [];
    return view.isFiltering && cards.length === 0
      ? []
      : [
          buildLane(buildInitiativeLaneId(initiative.id), initiative.name, null, cards, undefined, {
            initiativeId: initiative.id,
            hue: initiative.hue,
            isRow: false,
            doneRingCount: 0,
          }),
        ];
  });
  const hasDropTarget = !view.isFiltering && initiatives.length > 0;
  return loose.length === 0 && !hasDropTarget
    ? lanes
    : [...lanes, buildLane(NO_INITIATIVE_LANE_ID, NO_INITIATIVE_LANE_NAME, null, loose)];
};

/**
 * Returns the Initiative whose small flag `card` shows, or `undefined` when it
 * shows none. A card shows the flag under every grouping but Group by Project
 * (`groupBy` is the id of the grouping), where an Initiative has its own row
 * or the card is in its lane, so that its Initiative is not lost. A card whose
 * Initiative is not in `initiatives`, because it is closed, shows none.
 */
export const findCardInitiativeFlag = (
  card: WorkCard,
  groupBy: string,
  initiatives: readonly WorkInitiative[],
): WorkInitiative | undefined =>
  groupBy === PROJECT_FACET_ID
    ? undefined
    : initiatives.find((initiative) => initiative.id === card.initiativeId);
