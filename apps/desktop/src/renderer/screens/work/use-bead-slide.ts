import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  chooseTargetStage,
  describeCardMove,
  type CardMove,
  type WorkInitiative,
  type WorkProject,
} from "@hercule/client-core/work";
import type { BoardStage, WorkCard } from "@hercule/contract";
import { swallowNextClick, trackBody, trackCarryGesture, type MotionBody } from "../../app/motion";
import { computeSlideOffset, HELD_BEAD_SCALE, SLIDE_DISTANCE } from "./bead-slide";
import { pickStage, type StageEdge } from "./board-drag-geometry";
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
}

/** What a press on a bead found: the bead, its Task, and where the pointer was. */
interface Pressed {
  readonly element: HTMLElement;
  readonly taskId: string;
  readonly pressX: number;
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
   * Moves the Task of `taskId` to `stage` as a stage-only move, through the
   * same pipeline as every other move of a card. Returns whether a move was
   * sent: a card that has left the board, or already stands in `stage`, sends
   * none.
   */
  const moveToStage = (taskId: string, stage: BoardStage): boolean => {
    const options = readOptions();
    const card = options.cards.find((each) => each.id === taskId);
    if (card === undefined || card.stage === stage) return false;
    const move: CardMove = { taskId, stage };
    options.moveCard(move, describeCardMove(card, move, options.projects, options.initiatives));
    return true;
  };

  const lift = (pressed: Pressed): Slide | null => {
    const stage = readOptions().cards.find((each) => each.id === pressed.taskId)?.stage;
    if (stage === undefined || !pressed.element.isConnected) return null;
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
   * glide of `flipBoard` takes over the bead's offset and size). A bead that
   * stays, or whose move was not sent, comes home.
   */
  const drop = (slide: Slide): void => {
    swallowNextClick(true);
    delete slide.element.dataset["held"];
    const isSent = slide.element.isConnected && moveToStage(slide.taskId, slide.stage);
    if (!isSent || slide.element.isConnected) comeHome(slide, "hand");
  };

  const gesture = trackCarryGesture<Pressed, Slide>({
    element: scroller,
    liftDistance: SLIDE_DISTANCE,
    // A bead does not lean.
    lean: { perSpeed: 0, most: 0 },
    readPressed: (event) => {
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
      comeHome(slide, "travel");
    },
  });

  /** Shift and the left or right arrow on a focused bead moves its Task a stage, as on a card. */
  const onKeyDown = (event: KeyboardEvent): void => {
    const bead =
      event.target instanceof Element ? event.target.closest<HTMLElement>(BEAD_SELECTOR) : null;
    const taskId = bead?.dataset["beadTaskId"];
    if (event.defaultPrevented || taskId === undefined) return;
    const command = readBoardKey(event, false);
    if (command?.kind !== "shift-stage") return;
    event.preventDefault();
    const card = readOptions().cards.find((each) => each.id === taskId);
    const stage = card === undefined ? undefined : chooseTargetStage(card, command);
    if (stage === undefined || !moveToStage(taskId, stage)) return;
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
