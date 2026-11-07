/**
 * The facets of the Work board's Filter menu, built on the shared filter of
 * `@hercule/client-core/desk`: State (Has a question, Failed, With an agent)
 * and Project. Later slices add rows to `STATE_ROWS` or push facets of their
 * own onto the list.
 */
import type { WorkCard } from "@hercule/contract";
import type { FilterFacet, FilterValue } from "../desk/filter";
import { chooseLaneId, type WorkLane } from "./lanes";

/** The id of the State facet, whose values are Has a question, Failed and With an agent. */
export const STATE_FACET_ID = "state";

/** The id of the Project facet, which is also the id of the grouping by Project. */
export const PROJECT_FACET_ID = "project";

interface StateRow {
  readonly id: string;
  readonly name: string;
  /** Whether the row goes off by itself once no card has it. */
  readonly liftsItself?: true;
  readonly has: (card: WorkCard) => boolean;
}

const STATE_ROWS: readonly StateRow[] = [
  {
    id: "question",
    name: "Has a question",
    liftsItself: true,
    has: (card) => card.openQuestion !== undefined,
  },
  { id: "failed", name: "Failed", liftsItself: true, has: (card) => card.failure !== undefined },
  { id: "agent", name: "With an agent", has: (card) => card.workingSessionId !== undefined },
];

const buildStateFacet = (): FilterFacet<WorkCard> => ({
  id: STATE_FACET_ID,
  caption: "",
  values: STATE_ROWS.map((row): FilterValue => ({
    id: row.id,
    name: row.name,
    ...(row.liftsItself === true ? { liftsItself: true } : {}),
  })),
  hasValue: (card, valueId) => STATE_ROWS.find((row) => row.id === valueId)?.has(card) ?? false,
});

const buildProjectFacet = (lanes: readonly WorkLane[]): FilterFacet<WorkCard> => {
  const laneIds = new Set(lanes.map((lane) => lane.id));
  return {
    id: PROJECT_FACET_ID,
    caption: "Project",
    values: lanes.map((lane) => ({ id: lane.id, name: lane.name })),
    // A card of a deleted Project stands in "No project", so it has that value.
    hasValue: (card, valueId) => chooseLaneId(card, laneIds) === valueId,
  };
};

/**
 * Returns the facets of the Filter menu, in menu order. `lanes` must be the
 * lanes of the whole board, not the lanes the filter leaves, so that a
 * Project the filter hides stays in the menu to be chosen again.
 */
export const buildWorkFacets = (lanes: readonly WorkLane[]): readonly FilterFacet<WorkCard>[] => [
  buildStateFacet(),
  buildProjectFacet(lanes),
];
