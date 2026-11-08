/**
 * The facets of the Work board's Filter menu, built on the shared filter of
 * `@hercule/client-core/desk`: State (Has a question, Failed, With an agent)
 * and Project, then Source and one facet for each kind of outside place the
 * board can group by. Another state is one more row of `STATE_ROWS`; another facet is
 * one more entry of the list `buildWorkFacets` returns.
 */
import type { WorkBoard, WorkCard } from "@hercule/contract";
import {
  FROM_YOUR_SOURCES_HEADING,
  type Filter,
  type FilterFacet,
  type FilterValue,
} from "../desk/filter";
import { buildPlaceFacets } from "../desk/place-facets";
import { namePlugin, type PluginName } from "../intake";
import { chooseLaneId, type WorkLane } from "./lanes";

/** The id of the State facet, whose values are Has a question, Failed and With an agent. */
const STATE_FACET_ID = "state";

/** The id of the Project facet, which is also the id of the grouping by Project. */
export const PROJECT_FACET_ID = "project";

/** The id of the Source facet, whose values are the plugins that have a mark on a card. */
export const SOURCE_FACET_ID = "source";

/** The id of the Source value for a card whose Task links nothing outside. */
const NO_SOURCE_VALUE_ID = "(none)";

/** The filter that shows only the cards with a failed run: the State facet's Failed row. */
export const FAILED_FILTER: Filter = { [STATE_FACET_ID]: ["failed"] };

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

const buildSourceFacet = (
  cards: readonly WorkCard[],
  plugins: readonly PluginName[],
): FilterFacet<WorkCard> | undefined => {
  const pluginIds = [
    ...new Set(cards.flatMap((card) => card.entityMarks.map((mark) => mark.plugin))),
  ];
  if (pluginIds.length === 0) return undefined;
  const values = pluginIds
    .map((pluginId) => ({ id: pluginId, name: namePlugin(pluginId, plugins) }))
    .toSorted((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return {
    id: SOURCE_FACET_ID,
    caption: "Source",
    values: [...values, { id: NO_SOURCE_VALUE_ID, name: "No source" }],
    hasValue: (card, valueId) =>
      valueId === NO_SOURCE_VALUE_ID
        ? card.entityMarks.length === 0
        : card.entityMarks.some((mark) => mark.plugin === valueId),
  };
};

/**
 * Returns one facet for each kind of outside place the board can group by
 * (see `buildPlaceFacets`). A card has a place when the place is in its
 * `contextRefs`. Filtering only narrows the cards: it never changes a Task's
 * Project or Initiative.
 */
const buildContextFacets = (
  board: Pick<WorkBoard, "places" | "groupings">,
): readonly FilterFacet<WorkCard>[] => {
  const kinds = new Set(board.groupings.map((grouping) => grouping.kind));
  return buildPlaceFacets(
    board.places.filter((place) => kinds.has(place.kind)),
    (card: WorkCard) => card.contextRefs,
    FROM_YOUR_SOURCES_HEADING,
  );
};

/**
 * Returns the facets of the Filter menu, in menu order: State, Project, then
 * Source (when a card links something outside) and the outside places. `lanes`
 * must be the Project lanes of the whole board, and `board` the whole board,
 * not what the filter leaves, so that a value the filter hides stays in the
 * menu to be chosen again. `plugins` gives the names of the Source values.
 */
export const buildWorkFacets = (
  lanes: readonly WorkLane[],
  board: Pick<WorkBoard, "cards" | "places" | "groupings">,
  plugins: readonly PluginName[],
): readonly FilterFacet<WorkCard>[] => {
  const source = buildSourceFacet(board.cards, plugins);
  return [
    buildStateFacet(),
    buildProjectFacet(lanes),
    ...(source === undefined ? [] : [source]),
    ...buildContextFacets(board),
  ];
};
