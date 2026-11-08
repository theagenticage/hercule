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
  type Initiative,
  type WorkBoard,
  type WorkCard,
} from "@hercule/contract";

/** The part of a Project that a lane needs. */
export interface WorkProject {
  readonly id: string;
  readonly name: string;
}

/** The part of an Initiative that a lane needs. The list a screen passes holds the open Initiatives only. */
export type WorkInitiative = Pick<Initiative, "id" | "name" | "hue" | "projectId">;

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

/** What every lane for an Initiative has: which Initiative it is and how it is coloured. */
interface InitiativeLaneBase {
  readonly initiativeId: string;
  /** The hue of the Initiative's flag, line and beads, from `INITIATIVE_HUES`. */
  readonly hue: number;
}

/**
 * An Initiative row of Group by Project. It is folded to a line of beads
 * unless the user opens it.
 */
export interface InitiativeRowLane extends InitiativeLaneBase {
  readonly isRow: true;
  /** Only for a row In lanes: the id of the Project lane the row is drawn under. */
  readonly underLaneId?: string;
  /** Only for a row On top: the name of the Initiative's Project, which no lane above the row says. */
  readonly projectName?: string;
  /**
   * How many Done Tasks the row draws as rings at the end of Landed. Done
   * Tasks have no card, so the rings are all the board can show of them. It is
   * 0 while a filter is on, because a filter matches cards.
   */
  readonly doneRingCount: number;
}

/** A lane of Group by Initiative, which is an ordinary lane. */
export interface InitiativeGroupLane extends InitiativeLaneBase {
  readonly isRow: false;
}

/**
 * What a lane for an Initiative adds to a lane (see `initiative-lanes.ts`):
 * a row, or a lane of Group by Initiative. A drop there puts a card on the
 * Initiative and never changes its Project.
 */
export type InitiativeLane = InitiativeRowLane | InitiativeGroupLane;

/** One lane of the board: a Project (or an outside place) and its five cells, in `BOARD_STAGES` order. */
export interface WorkLane {
  /** The Project's id, `NO_PROJECT_LANE_ID`, or the id of an outside lane or an Initiative lane. */
  readonly id: string;
  readonly name: string;
  /** The Project a card dropped or added in this lane gets: `null` for no Project. Always `null` for an outside lane and for an Initiative lane. */
  readonly projectId: string | null;
  readonly cells: readonly LaneCell[];
  /** Set on a lane for an outside place, and on the "No <caption>" lane that goes with them. */
  readonly outside?: OutsideLane;
  /** Set on a lane for an Initiative: an Initiative row, or a lane of Group by Initiative. */
  readonly initiative?: InitiativeLane;
}

/**
 * Returns the id of the lane for `projectId`: the id itself when `projectIds`
 * holds it, else the "No project" lane. An Initiative draws in the lane of its
 * Project by the same rule as a card.
 */
export const chooseProjectLaneId = (
  projectId: string | undefined,
  projectIds: ReadonlySet<string>,
): string =>
  projectId !== undefined && projectIds.has(projectId) ? projectId : NO_PROJECT_LANE_ID;

/**
 * Returns the id of the lane a card stands in: its Project's id when
 * `projectIds` holds it, else the "No project" lane. A Project that is
 * deleted keeps its Tasks' `projectId` (spec 08), so a card can name a
 * Project that no longer exists; it is shown under "No project".
 */
export const chooseLaneId = (card: WorkCard, projectIds: ReadonlySet<string>): string =>
  chooseProjectLaneId(card.projectId, projectIds);

/** Returns a lane of these cards, with one cell per board stage. */
export const buildLane = (
  id: string,
  name: string,
  projectId: string | null,
  cards: readonly WorkCard[],
  { outside, initiative }: { outside?: OutsideLane; initiative?: InitiativeLane } = {},
): WorkLane => ({
  id,
  name,
  projectId,
  ...(outside === undefined ? {} : { outside }),
  ...(initiative === undefined ? {} : { initiative }),
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
 * activity never reaches here. A lane that would hold no card is left out,
 * unless its id is in `keptLaneIds` (a lane that holds Initiative rows).
 *
 * A card whose Project is missing from `projects` (a deleted Project) goes
 * under "No project". Call it with the cards the filter leaves, to draw the
 * board; call it with all cards to list every lane, for the Project facet.
 */
export const buildLanes = (
  board: Pick<WorkBoard, "cards">,
  projects: readonly WorkProject[],
  keptLaneIds: ReadonlySet<string> = new Set(),
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
    const cards = cardsByLane.get(project.id) ?? [];
    return cards.length === 0 && !keptLaneIds.has(project.id)
      ? []
      : [buildLane(project.id, project.name, project.id, cards)];
  });
  const unassigned = cardsByLane.get(NO_PROJECT_LANE_ID) ?? [];
  return unassigned.length === 0 && !keptLaneIds.has(NO_PROJECT_LANE_ID)
    ? lanes
    : [...lanes, buildLane(NO_PROJECT_LANE_ID, NO_PROJECT_LANE_NAME, null, unassigned)];
};
