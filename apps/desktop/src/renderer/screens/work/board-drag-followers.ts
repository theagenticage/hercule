/**
 * The cards carried behind the card in the hand when it is one of several
 * selected cards: picking them up, moving them after the hand, and reading
 * how they look when they let go.
 */
import type { WorkCard } from "@hercule/contract";
import { ghostElement, measureLayoutRect, trackBody } from "../../app/motion";
import { copyCardForMotion } from "../desk";
import type { Carry, Follower } from "./board-drag-carry";
import { readCardInLane } from "./card-in-lane";
import { hideDraggedCard } from "./dragged-card";
import { flipBoard } from "./flip-board";
import type { ReleasePose } from "./land-card";

/** How a selected card carried behind the card in the hand sits: each one further, in pixels, and smaller, as a share of its size. */
const FOLLOWER_OFFSET = 5;
const FOLLOWER_SHRINK = 0.02;

/** How long, in milliseconds, each card carried behind the first lands after the one before it. */
export const FOLLOWER_LAND_GAP = 40;

/** What picking up the followers needs to know about the board. */
interface FollowedCards {
  /** The ids of the selected cards. */
  readonly selectedIds: ReadonlySet<string>;
  /** The cards the board draws. */
  readonly cards: readonly WorkCard[];
}

/** Sends the cards behind the one in hand after it as a stack: each 5px further along and 2% smaller than the one before. */
export const moveFollowers = (c: Carry): void => {
  const x = c.hand.x - c.grab.x;
  const y = c.hand.y - c.grab.y;
  for (const follower of c.followers) {
    follower.body.to(
      {
        x: x + follower.depth * FOLLOWER_OFFSET - follower.home.left,
        y: y + follower.depth * FOLLOWER_OFFSET - follower.home.top,
        s: 1 - follower.depth * FOLLOWER_SHRINK,
      },
      "travel",
      { reduced: c.reduced },
    );
  }
};

/** Reads how the copy of a follower looks now, for its landing to start from. It has no speed: it trails the hand. */
export const readFollowerPose = (follower: Follower): ReleasePose => {
  const shown = follower.body.values;
  return {
    centerX: follower.home.left + follower.home.width / 2 + shown.x,
    centerY: follower.home.top + follower.home.height / 2 + shown.y,
    scale: shown.s,
    tilt: shown.r,
    lift: shown.l,
    velocity: { x: 0, y: 0 },
  };
};

/**
 * Picks up the selected cards other than the pressed one, when the pressed
 * card is selected: each is copied into the carry layer where it stands,
 * and hidden in the page. The cards are taken in the order the board draws
 * them, and only those the board draws and the screen knows. The cards
 * below the hidden ones glide up.
 */
export const liftFollowers = (
  scroller: HTMLElement,
  layer: HTMLElement,
  pressed: WorkCard,
  options: FollowedCards,
): readonly Follower[] => {
  if (!options.selectedIds.has(pressed.id)) return [];
  const followers: Follower[] = [];
  const elements: HTMLElement[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-card-id]")) {
    const card = options.cards.find((each) => each.id === element.dataset["cardId"]);
    const at = readCardInLane(element);
    // A Task under two outside places has a card in each lane. It is carried once.
    if (
      card === undefined ||
      at === null ||
      card.id === pressed.id ||
      !options.selectedIds.has(card.id) ||
      followers.some((follower) => follower.card.id === card.id)
    ) {
      continue;
    }
    const depth = followers.length + 1;
    const home = measureLayoutRect(element);
    const ghost = ghostElement(element, layer, copyCardForMotion(element));
    ghost.classList.add("is-follower");
    // Each card sits behind the one before it.
    ghost.style.zIndex = String(-depth);
    followers.push({ card, laneId: at.laneId, ghost, body: trackBody(ghost), home, depth });
    elements.push(element);
  }
  // The copies are measured and made first, so hiding the cards moves nothing they were copied from.
  flipBoard(scroller, "hand", () => {
    for (const element of elements) hideDraggedCard(element);
  });
  return followers;
};
