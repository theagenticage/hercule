/**
 * The lanes of the Work board: one per Project that has a card, in a fixed
 * order, then "No project". Each lane holds one cell per board stage.
 *
 * The cards of a cell come in the order of `WorkBoard.cards`, which is the
 * stored order (`task.queryBoard` sorts by `boardRank`; a board the client
 * changed with `applyCardMove` keeps the same order). The client never sorts
 * by `boardRank` itself, because a card it has moved has no rank it could
 * truthfully compare. See `card-move.ts`.
 */
import {
  BOARD_STAGES,
  type BoardStage,
  type EntityPlace,
  type WorkBoard,
  type WorkCard,
} from "@hercule/contract";

/** The part of a Project that a lane needs. */
export interface WorkProject {
  readonly id: string;
  readonly name: string;
}

/** The id of the lane for Tasks that have no Project. */
export const NO_PROJECT_LANE_ID = "no-project";

/** The name of the lane for Tasks that have no Project. */
export const NO_PROJECT_LANE_NAME = "No project";

/** The cards of one lane at one stage, in stored order. */
export interface LaneCell {
  readonly stage: BoardStage;
  readonly cards: readonly WorkCard[];
}

/** What a card says when its Task stands under more than one place of the lane's kind. */
export interface CardPlaces {
  /** For example "In 2 projects". */
  readonly summary: string;
  /** The title of each place, ordered by name, for the hover. */
  readonly names: readonly string[];
}

/**
 * What a lane for an outside place adds to a lane (see `context-lanes.ts`).
 * The lane belongs to the source: a drop there changes a card's stage and
 * never its membership.
 */
export interface OutsideLane {
  /** The plugin whose mark the lane shows, or `null` for the "No <caption>" lane, which has no mark. */
  readonly pluginId: string | null;
  /** The words for the kind of place, such as "Linear project". */
  readonly caption: string;
  /** What the place says about itself. Absent for the "No <caption>" lane or when it reports none. */
  readonly status?: EntityPlace["status"];
  /** Only when the source reports it. It is never worked out from the cards. */
  readonly progress?: EntityPlace["progress"];
  /** By Task id: the cards of this lane whose Task stands under more than one place of this kind. */
  readonly cardPlaces: Readonly<Record<string, CardPlaces>>;
}

/** One lane of the board: a Project (or an outside place) and its five cells, in `BOARD_STAGES` order. */
export interface WorkLane {
  /** The Project's id, `NO_PROJECT_LANE_ID`, or the id of an outside lane. */
  readonly id: string;
  readonly name: string;
  /** The Project a card dropped or added in this lane gets: `null` for no Project. Always `null` for an outside lane. */
  readonly projectId: string | null;
  readonly cells: readonly LaneCell[];
  /** Set on a lane for an outside place, and on the "No <caption>" lane that goes with them. */
  readonly outside?: OutsideLane;
}

/**
 * Returns the id of the lane a card stands in: its Project's id when
 * `projectIds` holds it, else the "No project" lane. A Project that is
 * deleted keeps its Tasks' `projectId` (spec 08), so a card can name a
 * Project that no longer exists; it is shown under "No project".
 */
export const chooseLaneId = (card: WorkCard, projectIds: ReadonlySet<string>): string =>
  card.projectId !== undefined && projectIds.has(card.projectId)
    ? card.projectId
    : NO_PROJECT_LANE_ID;

/** Returns a lane of these cards, with one cell per board stage. */
export const buildLane = (
  id: string,
  name: string,
  projectId: string | null,
  cards: readonly WorkCard[],
  outside?: OutsideLane,
): WorkLane => ({
  id,
  name,
  projectId,
  ...(outside === undefined ? {} : { outside }),
  cells: BOARD_STAGES.map((stage) => ({
    stage,
    cards: cards.filter((card) => card.stage === stage),
  })),
});

/** Orders Projects by name, then by id so that two Projects with one name keep a fixed order. */
const compareProjects = (a: WorkProject, b: WorkProject): number =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Returns the lanes of the board, in the order they are drawn: Projects
 * sorted by name, then "No project" last. The sidebar's order of recent
 * activity never reaches here. A lane that would hold no card is left out.
 *
 * A card whose Project is missing from `projects` (a deleted Project) goes
 * under "No project". Call it with the cards the filter leaves, to draw the
 * board; call it with all cards to list every lane, for the Project facet.
 */
export const buildLanes = (
  board: Pick<WorkBoard, "cards">,
  projects: readonly WorkProject[],
): readonly WorkLane[] => {
  const projectIds = new Set(projects.map((project) => project.id));
  const cardsByLane = new Map<string, WorkCard[]>();
  for (const card of board.cards) {
    const laneId = chooseLaneId(card, projectIds);
    const cards = cardsByLane.get(laneId);
    if (cards === undefined) cardsByLane.set(laneId, [card]);
    else cards.push(card);
  }
  const lanes = [...projects].sort(compareProjects).flatMap((project) => {
    const cards = cardsByLane.get(project.id);
    return cards === undefined ? [] : [buildLane(project.id, project.name, project.id, cards)];
  });
  const unassigned = cardsByLane.get(NO_PROJECT_LANE_ID);
  return unassigned === undefined
    ? lanes
    : [...lanes, buildLane(NO_PROJECT_LANE_ID, NO_PROJECT_LANE_NAME, null, unassigned)];
};
