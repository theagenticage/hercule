/**
 * Group by an outside context: the "From your sources" rows of the Group by
 * menu, and the lanes of one such grouping. A context is a place the source
 * reports, such as a Linear project or a GitHub repository, and a kind of
 * place can group when its plugin declares it `groupable`.
 *
 * The lanes use the same shape as the Project lanes, so the board draws them
 * with the same code. Their `outside` field is what tells them apart.
 */
import type { EntityGrouping, EntityPlace, WorkBoard, WorkCard } from "@hercule/contract";
import { describeLockedRow } from "../desk/relation-rows";
import { lowerFirst } from "../text";
import { parsePluginId } from "../plugin-id";
import { buildLane, type CardPlaces, type WorkLane } from "./lanes";

/** One row of the "From your sources" part of Group by. */
export interface BoardGrouping extends EntityGrouping {
  /** The plugin that owns the kind, for the mark in front of the row. */
  readonly pluginId: string | null;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns the kinds of outside place this board can be grouped by: the
 * groupable kinds that have at least one place on it, each with its caption,
 * ordered by caption. A kind with no place on the board is not listed, so a
 * plugin that reports nothing adds no row.
 */
export const listBoardGroupings = (board: Pick<WorkBoard, "groupings">): readonly BoardGrouping[] =>
  board.groupings
    .map((grouping) => ({ ...grouping, pluginId: parsePluginId(grouping.kind) }))
    .toSorted((a, b) => a.caption.localeCompare(b.caption) || compareText(a.kind, b.kind));

const PLACE_LANE_PREFIX = "place:";

/** Returns the id of the lane for the place `ref`. */
const buildPlaceLaneId = (ref: string): string => `${PLACE_LANE_PREFIX}${ref}`;

/** Returns the id of the lane "No <caption>" for the cards under no place of `kind`. */
const buildNoPlaceLaneId = (kind: string): string => `none:${kind}`;

/**
 * Returns the ref of the place a lane is for, or `undefined` for a Project
 * lane and for the "No <caption>" lane, which stand for no one place.
 */
export const readPlaceLaneRef = (laneId: string): string | undefined =>
  laneId.startsWith(PLACE_LANE_PREFIX) ? laneId.slice(PLACE_LANE_PREFIX.length) : undefined;

/** Returns the name of a place: its title, or a plain sentence for a place the user cannot read. */
export const readPlaceName = (place: EntityPlace): string =>
  place.title ?? describeLockedRow(place);

/** Returns the plural of a noun of the kind table, such as "Project" or "Repository". */
export const pluralizeNoun = (noun: string): string => {
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return /(s|x|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`;
};

/** Returns what a card says when its Task stands under `places`, two or more of one kind. */
const describeCardPlaces = (places: readonly EntityPlace[]): CardPlaces => ({
  summary: `In ${String(places.length)} ${pluralizeNoun(lowerFirst(places[0]?.noun ?? ""))}`,
  names: places.map(readPlaceName).toSorted((a, b) => a.localeCompare(b)),
});

/**
 * Returns the lanes of the board grouped by the outside places of `kind`: one
 * per place that has a card, ordered by name, then a last lane "No <caption>"
 * for the cards under no place of that kind. A lane with no card is left out.
 *
 * - A Task matches a place through its `contextRefs` only. The server already
 *   leaves out the ancestors of a peer, so nothing here walks `edges`.
 * - A Task under two places has a card in each lane. Each of those cards has
 *   an entry in the lane's `outside.cardPlaces`, such as "In 2 projects".
 * - The cards of a lane keep the order of `board.cards`.
 * - A lane's `projectId` is `null`, and its `outside` is set: a drop there
 *   changes the stage and never the membership (see `buildDropMove`).
 *
 * Returns no lane when `kind` is not one of `board.groupings`, so the caller
 * should check the choice with `listBoardGroupings` and fall back to Project.
 * Call it with the cards the filter leaves, to draw the board, and with all
 * cards to list every lane.
 */
export const groupBoardByContext = (
  board: Pick<WorkBoard, "cards" | "places" | "groupings">,
  kind: string,
): readonly WorkLane[] => {
  const caption = board.groupings.find((grouping) => grouping.kind === kind)?.caption;
  if (caption === undefined) return [];
  const pluginId = parsePluginId(kind);
  const placesByRef = new Map(
    board.places.filter((place) => place.kind === kind).map((place) => [place.ref, place]),
  );
  const cardsByRef = new Map<string, WorkCard[]>();
  const placesOfCard = new Map<string, EntityPlace[]>();
  const loose: WorkCard[] = [];
  for (const card of board.cards) {
    // A ref can repeat in a card's list only if the server sent it twice; a Set keeps one card per lane.
    const places = [...new Set(card.contextRefs)].flatMap((ref) => {
      const place = placesByRef.get(ref);
      return place === undefined ? [] : [place];
    });
    if (places.length === 0) loose.push(card);
    for (const place of places) {
      const cards = cardsByRef.get(place.ref);
      if (cards === undefined) cardsByRef.set(place.ref, [card]);
      else cards.push(card);
    }
    if (places.length > 1) placesOfCard.set(card.id, places);
  }
  const lanes = [...cardsByRef.keys()]
    .map((ref) => placesByRef.get(ref)!)
    .toSorted(
      (a, b) => readPlaceName(a).localeCompare(readPlaceName(b)) || compareText(a.ref, b.ref),
    )
    .map((place) => {
      const cards = cardsByRef.get(place.ref) ?? [];
      const cardPlaces = Object.fromEntries(
        cards.flatMap((card) => {
          const places = placesOfCard.get(card.id);
          return places === undefined ? [] : [[card.id, describeCardPlaces(places)] as const];
        }),
      );
      return buildLane(buildPlaceLaneId(place.ref), readPlaceName(place), null, cards, {
        outside: {
          pluginId,
          caption,
          ...(place.status === undefined ? {} : { status: place.status }),
          ...(place.progress === undefined ? {} : { progress: place.progress }),
          cardPlaces,
        },
      });
    });
  return loose.length === 0
    ? lanes
    : [
        ...lanes,
        buildLane(buildNoPlaceLaneId(kind), `No ${caption}`, null, loose, {
          outside: { pluginId: null, caption, cardPlaces: {} },
        }),
      ];
};

/**
 * Returns the ids of the lanes `card` stands in when the board is grouped by
 * the places of `kind`: one per place of that kind in its `contextRefs`, or
 * the "No <caption>" lane when it has none. It names the same lanes as
 * `groupBoardByContext`, for code that must find a card's cells before the
 * lanes are built.
 */
export const listContextLaneIds = (
  card: Pick<WorkCard, "contextRefs">,
  places: readonly EntityPlace[],
  kind: string,
): readonly string[] => {
  const placeRefs = new Set(
    places.filter((place) => place.kind === kind).map((place) => place.ref),
  );
  const refs = [...new Set(card.contextRefs)].filter((ref) => placeRefs.has(ref));
  return refs.length === 0 ? [buildNoPlaceLaneId(kind)] : refs.map(buildPlaceLaneId);
};
