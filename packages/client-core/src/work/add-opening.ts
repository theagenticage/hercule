/**
 * What the Add to Work sheet opens on: the source and the context it
 * searches first. It follows what the user was looking at, so a person who
 * adds from the lane of one repository starts searching that repository.
 */
import type { EntityPlace } from "@hercule/contract";
import type { Filter } from "../desk/filter";
import { parsePluginId } from "../plugin-id";
import { SOURCE_FACET_ID } from "./facets";
import { readPlaceLaneRef } from "./context-lanes";
import { chooseLaneId, NO_PROJECT_LANE_ID, type WorkLane } from "./lanes";

/** The source and context the sheet opens on. A part that is absent means no choice was made. */
export interface AddOpening {
  /** The plugin id of the source tab to open on. */
  readonly sourceId?: string;
  /** The ref of the context that narrows the search, such as one repository. */
  readonly scopeRef?: string;
}

/** Returns whether `place` can narrow a search: it can group things and the user can read it. */
const isContext = (place: EntityPlace): boolean => place.caption !== undefined && !place.restricted;

/** Returns the opening that searches inside `place`. */
const openOnPlace = (place: EntityPlace): AddOpening => {
  const sourceId = parsePluginId(place.kind);
  return { ...(sourceId === null ? {} : { sourceId }), scopeRef: place.ref };
};

/**
 * Returns the context that most cards of `lane` sit under, or `undefined`
 * when no card sits under any. A card's `contextRefs` already hold the
 * places above what its Task links. A tie goes to the lowest ref, so the
 * choice does not change between two reads.
 */
const findLaneContext = (
  lane: Pick<WorkLane, "cells">,
  contexts: ReadonlyMap<string, EntityPlace>,
): EntityPlace | undefined => {
  const tally = new Map<string, number>();
  for (const cell of lane.cells) {
    for (const card of cell.cards) {
      for (const ref of new Set(card.contextRefs)) {
        if (contexts.has(ref)) tally.set(ref, (tally.get(ref) ?? 0) + 1);
      }
    }
  }
  const [best] = [...tally].toSorted(([refA, a], [refB, b]) => b - a || (refA < refB ? -1 : 1));
  return best === undefined ? undefined : contexts.get(best[0]);
};

/**
 * Returns the Project that a Task added from `lane` joins, or `null` for none.
 *
 * - A Project lane gives its own Project, and the "No project" lane gives
 *   `null`.
 * - A lane for an outside place has no Project of its own (a drop there never
 *   changes membership), so a new Task takes the Project that most of its
 *   cards are in. Only a Project in `projectIds` counts: a card whose Project
 *   was deleted counts as being in no Project, as the board draws it.
 * - The Project must have more cards than every other Project and more than
 *   the cards with no Project. On a tie, or when most cards have no Project,
 *   the answer is `null`: the new Task shows under "No <caption>" rather than
 *   in a Project picked by chance.
 */
export const chooseLaneProject = (
  lane: Pick<WorkLane, "projectId" | "outside" | "cells">,
  projectIds: ReadonlySet<string>,
): string | null => {
  if (lane.outside === undefined) return lane.projectId;
  const tally = new Map<string, number>();
  for (const cell of lane.cells) {
    for (const card of cell.cards) {
      const laneId = chooseLaneId(card, projectIds);
      tally.set(laneId, (tally.get(laneId) ?? 0) + 1);
    }
  }
  const [best, runnerUp] = [...tally].toSorted(([, a], [, b]) => b - a);
  return best !== undefined && best[0] !== NO_PROJECT_LANE_ID && best[1] > (runnerUp?.[1] ?? 0)
    ? best[0]
    : null;
};

/**
 * Decides what the sheet opens on.
 *
 * - From a lane's `+`, the lane decides. A lane for one outside place opens
 *   on that place. A Project lane opens on the context most of its cards sit
 *   under, or on nothing when none does.
 * - From anywhere else (the Add button, the `A` key), a filter on a context
 *   opens on that context. Failing that, a filter on a source opens on that
 *   source, searching all of it.
 * - Otherwise nothing is chosen, and the sheet starts on its first source,
 *   searching everything.
 *
 * `places` are the board's stored places, `filter` is the board's current
 * filter, and `lane` is the lane the user pressed `+` in, when they did.
 */
export const chooseAddOpening = ({
  places,
  filter,
  lane,
}: {
  readonly places: ReadonlyArray<EntityPlace>;
  readonly filter: Filter;
  readonly lane?: Pick<WorkLane, "id" | "cells"> | undefined;
}): AddOpening => {
  const contexts = new Map(places.filter(isContext).map((place) => [place.ref, place]));
  if (lane !== undefined) {
    const placeRef = readPlaceLaneRef(lane.id);
    const place = placeRef === undefined ? findLaneContext(lane, contexts) : contexts.get(placeRef);
    return place === undefined ? {} : openOnPlace(place);
  }
  const filtered = Object.values(filter)
    .flat()
    .flatMap((value) => {
      const place = contexts.get(value);
      return place === undefined ? [] : [place];
    })[0];
  if (filtered !== undefined) return openOnPlace(filtered);
  const sourceId = filter[SOURCE_FACET_ID]?.[0];
  return sourceId === undefined ? {} : { sourceId };
};
