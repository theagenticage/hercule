import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  chooseTargetStage,
  describeCardMove,
  type CardMove,
  type WorkInitiative,
  type WorkProject,
} from "@hercule/client-core/work";
import type { BoardStage, WorkCard } from "@hercule/contract";
import {
  swallowNextClick,
  trackBody,
  trackCarryGesture,
  type MotionBody,
  type SpringName,
} from "../../app/motion";
import { computeSlideOffset, HELD_BEAD_SCALE, SLIDE_DISTANCE } from "./bead-slide";
import { pickStage, type StageEdge } from "./board-drag-geometry";
import { flipBoard } from "./flip-board";
import { measureStageEdges } from "./measure-board-geometry";
import { readBoardKey } from "./read-board-key";

/** Selects a bead on an Initiative's line that is a button; its attribute is the id of its Task. */
const BEAD_SELECTOR = "[data-bead-task-id]";

/** What `useBeadSlide` is given. */
export interface BeadSlideOptions {
  /** The element that scrolls the board. It stays mounted for the life of the screen. */
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** The cards of the logical board, in stored order: the board as it is now. */
  readonly cards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  readonly initiatives: readonly WorkInitiative[];
  /**
   * Moves a card and shows the move on the undo line, with Undo, the offline
   * queue and the glide of the cards (`CardMoves.moveCardWithMotion`). It
   * commits the move to the page before it returns.
   */
  readonly moveCard: (move: CardMove, words: string) => void;
  /**
   * Tells the screen whether a bead is in the hand, the same value a card in
   * the hand of a drag sets: the board's reads wait for it, and Undo and the
   * board keys stand still. It is called with `true` when a bead is lifted and
   * with `false` when the bead is put down, inside the change that shows the
   * bead's new place.
   */
  readonly onCarryingChange: (isCarrying: boolean) => void;
  /**
   * Whether a card or a bead is in the hand, or a card waits for its merge
   * check. No bead is pressed or moved by key meanwhile.
   */
  readonly isCarrying: boolean;
}

/** What a press on a bead found: the bead, its Task, and where the pointer was. */
interface Pressed {
  readonly element: HTMLElement;
  readonly taskId: string;
  readonly pressX: number;
}

/** A move to send, with the words for the undo line. */
interface PlannedMove {
  readonly move: CardMove;
  readonly words: string;
}

/** A bead in the hand. */
interface Slide extends Pressed {
  readonly body: MotionBody;
  /** The left edge of the bead before it moved, in window pixels. */
  readonly restingLeft: number;
  /** The edge of each stage, in window pixels. */
  readonly edges: readonly StageEdge[];
  /** The stage under the pointer. */
  stage: BoardStage;
}

/**
 * Handles the pointer and the keys on the beads of the folded lines under
 * `scroller` for as long as it lives. Returns `destroy`, which stops
 * listening and puts a bead that is in the hand back.
 *
 * Both are delegated to `scroller`, so a line of many beads has no listener
 * of its own on any of them.
 */
const createBeadSlide = (
  scroller: HTMLElement,
  readOptions: () => BeadSlideOptions,
): { readonly destroy: () => void } => {
  /** Sends the bead back to its place and its size on `spring`, and hands it back to the stylesheet. */
  const comeHome = (slide: Slide, spring: "hand" | "travel"): void => {
    delete slide.element.dataset["held"];
    slide.body.to({ x: 0, s: 1 }, spring);
  };

  /**
   * Returns the stage-only move that sends the Task of `taskId` to `stage`,
   * with the words for the undo line, or `undefined` when the card has left
   * the board or already stands in `stage`.
   */
  const planMove = (taskId: string, stage: BoardStage): PlannedMove | undefined => {
    const options = readOptions();
    const card = options.cards.find((each) => each.id === taskId);
    if (card === undefined || card.stage === stage) return undefined;
    const move: CardMove = { taskId, stage };
    return { move, words: describeCardMove(card, move, options.projects, options.initiatives) };
  };

  /**
   * Sends `plan` through the same pipeline as every other move of a card, and
   * commits it to the page. With `isReleasing`, the hand lets go of the bead in
   * the same committed change, so the board is drawn once with both.
   */
  const sendMove = (plan: PlannedMove, isReleasing: boolean): void => {
    const options = readOptions();
    flushSync(() => {
      if (isReleasing) options.onCarryingChange(false);
      options.moveCard(plan.move, plan.words);
    });
  };

  /**
   * Lets the bead go when no move follows: the screen shows what it held back
   * for the carry, and the board glides to it on `spring`.
   */
  const putDownWithoutMove = (spring: SpringName): void => {
    flipBoard(scroller, spring, () => {
      flushSync(() => {
        readOptions().onCarryingChange(false);
      });
    });
  };

  const lift = (pressed: Pressed): Slide | null => {
    const stage = readOptions().cards.find((each) => each.id === pressed.taskId)?.stage;
    if (stage === undefined || !pressed.element.isConnected) return null;
    // The screen is told first and at once, so what it holds back for the carry
    // is held before the bead moves, and a push cannot take the bead away.
    flushSync(() => {
      readOptions().onCarryingChange(true);
    });
    const body = trackBody(pressed.element);
    pressed.element.dataset["held"] = "";
    return {
      ...pressed,
      body,
      restingLeft: pressed.element.getBoundingClientRect().left,
      edges: measureStageEdges(scroller),
      stage,
    };
  };

  const follow = (slide: Slide, event: PointerEvent): void => {
    // A push removed the bead while it was in the hand: there is nothing to slide.
    if (!slide.element.isConnected) {
      gesture.cancel(false);
      return;
    }
    const edgeLefts = slide.edges.map((edge) => edge.left);
    const x = computeSlideOffset(slide.restingLeft, event.clientX - slide.pressX, edgeLefts);
    slide.body.to({ x, s: HELD_BEAD_SCALE }, "hand");
    slide.stage = pickStage(slide.edges, event.clientX) ?? slide.stage;
  };

  /**
   * Lets go of the bead: its Task moves to the stage under the pointer, and
   * the bead comes down in its new cell from where the hand left it (the
   * glide of `flipBoard` takes over the bead's offset and size). The bead
   * leaves the hand in the same change as the move. A bead that stays, or
   * whose move was not sent, comes home.
   */
  const drop = (slide: Slide): void => {
    swallowNextClick(true);
    const plan = slide.element.isConnected ? planMove(slide.taskId, slide.stage) : undefined;
    if (plan === undefined) {
      putDownWithoutMove("hand");
      comeHome(slide, "hand");
      return;
    }
    // Not held any more, so the glide of the board takes the bead over.
    delete slide.element.dataset["held"];
    sendMove(plan, true);
    if (slide.element.isConnected) comeHome(slide, "hand");
  };

  const gesture = trackCarryGesture<Pressed, Slide>({
    element: scroller,
    liftDistance: SLIDE_DISTANCE,
    // A bead does not lean.
    lean: { perSpeed: 0, most: 0 },
    readPressed: (event) => {
      if (readOptions().isCarrying) return null;
      const element =
        event.target instanceof Element ? event.target.closest<HTMLElement>(BEAD_SELECTOR) : null;
      const taskId = element?.dataset["beadTaskId"];
      return element === null || taskId === undefined
        ? null
        : { element, taskId, pressX: event.clientX };
    },
    lift,
    move: follow,
    drop,
    cancel: (slide, isPointerUp) => {
      swallowNextClick(isPointerUp);
      // The bead is still marked held while the board glides, which leaves it to its own spring.
      putDownWithoutMove("travel");
      comeHome(slide, "travel");
    },
  });

  /** Shift and the left or right arrow on a focused bead moves its Task a stage, as on a card. */
  const onKeyDown = (event: KeyboardEvent): void => {
    const bead =
      event.target instanceof Element ? event.target.closest<HTMLElement>(BEAD_SELECTOR) : null;
    const taskId = bead?.dataset["beadTaskId"];
    if (event.defaultPrevented || taskId === undefined || readOptions().isCarrying) return;
    const command = readBoardKey(event, false);
    if (command?.kind !== "shift-stage") return;
    event.preventDefault();
    const card = readOptions().cards.find((each) => each.id === taskId);
    const stage = card === undefined ? undefined : chooseTargetStage(card, command);
    const plan = stage === undefined ? undefined : planMove(taskId, stage);
    if (plan === undefined) return;
    sendMove(plan, false);
    // The bead is a new element in its new cell, and focus went with the old one.
    scroller
      .querySelector<HTMLElement>(`[data-bead-task-id="${CSS.escape(taskId)}"]`)
      ?.focus({ preventScroll: true });
  };
  scroller.addEventListener("keydown", onKeyDown);

  return {
    destroy: () => {
      scroller.removeEventListener("keydown", onKeyDown);
      const held = gesture.destroy();
      if (held !== null) {
        readOptions().onCarryingChange(false);
        delete held.element.dataset["held"];
        held.body.clear();
      }
    },
  };
};

/**
 * Lets the user move the Task of a bead on a folded Initiative line to
 * another stage, by hand or by key.
 *
 * - Pressing a bead and moving the pointer past 4px along the line slides it.
 *   The bead follows the pointer on `hand` at 1.5 times its size, and near the
 *   start of a stage the stage pulls it by 45% of the distance, like a bead
 *   finding a notch. Letting go sends a stage-only move to the stage under the
 *   pointer, and the bead comes down there from where the hand left it. A press
 *   that does not move is a click, which opens the Task as before.
 * - Esc, a cancelled or lost pointer and a hidden window send the bead home
 *   on `travel` and send nothing.
 * - Shift with the left or right arrow on a focused bead moves its Task a
 *   stage, as on a card, and focus stays on the bead.
 * - Under Reduce motion the bead follows the pointer with no spring, and the
 *   bead in its new cell fades in.
 *
 * The line is measured once, when the slide starts.
 */
export function useBeadSlide(options: BeadSlideOptions): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { scrollRef } = options;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    return createBeadSlide(scroller, () => latest.current).destroy;
  }, [scrollRef]);
}
