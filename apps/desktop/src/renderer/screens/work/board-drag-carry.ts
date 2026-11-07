/** The shapes of a card in the hand and of what it carries, shared by the parts of the board's drag. */
import type { DropPlace } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import type { LayoutRect, MotionBody } from "../../app/motion";
import type { MergeGesture } from "./board-drag-merge";
import type { BoardGeometry, BoardView } from "./board-drag-geometry";

/** How much bigger a card is in the hand. */
export const CARRY_SCALE = 1.03;

/** The pointer's last place, and how fast it moves (pixels per millisecond, smoothed). */
export interface Hand {
  x: number;
  y: number;
  vx: number;
  vy: number;
  movedAt: number;
}

/** A selected card carried behind the card in the hand. */
export interface Follower {
  readonly card: WorkCard;
  /** The copy of the card behind the one in hand, in the carry layer. */
  readonly ghost: HTMLElement;
  readonly body: MotionBody;
  /** Where the layout puts the copy, in window pixels. */
  readonly home: LayoutRect;
  /** How many places behind the card in the hand it rides: 1 is right behind it. */
  readonly depth: number;
}

/** A card in the hand. */
export interface Carry {
  readonly pointerId: number;
  readonly card: WorkCard;
  /** The card's element in the page. It stays mounted and hidden for the whole carry. */
  readonly source: HTMLElement;
  readonly root: HTMLElement;
  readonly layer: HTMLElement;
  /** The copy of the card in the hand, the only child of `layer`. */
  readonly ghost: HTMLElement;
  readonly body: MotionBody;
  /** The selected cards carried behind it, in the order they land. Empty for a card carried alone. */
  readonly followers: readonly Follower[];
  /** The hollow that shows where the card would land. It lives in the cell, outside React's reach. */
  readonly slot: HTMLElement;
  /** Where the layout puts the copy in the hand, in window pixels. */
  readonly home: LayoutRect;
  /** Where in the card the pointer took hold of it. */
  readonly grab: { readonly x: number; readonly y: number };
  readonly reduced: boolean;
  readonly watcher: MutationObserver;
  readonly hand: Hand;
  geometry: BoardGeometry;
  /** The scroller in the window, and how far it is scrolled. */
  view: BoardView;
  place: DropPlace | null;
  uprightTimer: number | undefined;
  scrollFrame: number;
  /** The folded lane that is marked as the target, if one is. */
  markedLane: HTMLElement | null;
  /** The merge of the carry into a card: the wait, the card chosen, the dock and the marks. */
  readonly merge: MergeGesture;
}
