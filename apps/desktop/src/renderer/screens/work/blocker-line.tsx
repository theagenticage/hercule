import { useEffect, useState, type JSX, type RefObject } from "react";
import {
  buildRoundedPath,
  LINE_CORNER_RADIUS,
  routeBlockerLine,
  type Box,
} from "./blocker-line-geometry";
import "./blocker-line.css";

/** How long the pointer rests on a blocked card before the line to its blocker is drawn. */
export const BLOCKER_LINE_DELAY_MS = 240;

/** The class a card wears while a line points at it. */
const BLOCKER_CLASS = "is-blocker";

/** Finds a blocked card by what it carries: its state and the id of the Task that blocks it. */
const BLOCKED_CARD_SELECTOR = '.desk-card[data-state="blocked"][data-blocked-by]';

/** A line to draw: its SVG path, and the point where it ends on the blocker. */
interface DrawnLine {
  readonly path: string;
  readonly endX: number;
  readonly endY: number;
}

/** Returns the box of `element` in the coordinates of `origin`, which is the canvas's own top left corner. */
const measureBox = (element: Element, origin: DOMRect): Box => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  };
};

/**
 * Returns the card of Task `taskId` on the board, or `null` when the board
 * draws none: the Task is not on it, or its lane is folded or its cell is
 * closed, so the card is not drawn or has no size. `except` is the blocked card
 * itself, which a Task standing under two lanes could otherwise match.
 */
const findCardOnBoard = (canvas: Element, taskId: string, except: Element): HTMLElement | null => {
  for (const card of canvas.querySelectorAll<HTMLElement>("[data-card-id]")) {
    if (card === except || card.dataset["cardId"] !== taskId) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return card;
  }
  return null;
};

/**
 * Draws the thin line from a blocked card to the card that blocks it, over the
 * board, while the pointer rests on the blocked card, and rings the blocker.
 * It explains and holds no structure: nothing is drawn when the blocker is
 * not on the board, and the line goes as soon as the pointer leaves the card,
 * presses, or the board changes size.
 *
 * `canvasRef` is the board's canvas, which scrolls with the cards and is the
 * line's own positioned ancestor, so the line moves with the cards. One
 * listener on the canvas serves every card. At rest nothing runs: no timer, no
 * observer, and no measuring. A card is measured only when its line is drawn.
 * The line fades in, and under Reduce motion it simply appears.
 */
export function BlockerLine({
  canvasRef,
}: {
  readonly canvasRef: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const [line, setLine] = useState<DrawnLine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // The blocked card the pointer rests on, from the moment the timer starts until the pointer leaves it.
    let resting: Element | null = null;
    let timer: number | undefined;
    let ringed: Element | null = null;
    let observer: ResizeObserver | null = null;

    const hide = (): void => {
      window.clearTimeout(timer);
      timer = undefined;
      observer?.disconnect();
      observer = null;
      ringed?.classList.remove(BLOCKER_CLASS);
      ringed = null;
      setLine(null);
    };

    const draw = (card: HTMLElement): void => {
      const blockerId = card.dataset["blockedBy"];
      const blocker = blockerId === undefined ? null : findCardOnBoard(canvas, blockerId, card);
      if (blocker === null) return;
      const origin = canvas.getBoundingClientRect();
      const route = routeBlockerLine(measureBox(card, origin), measureBox(blocker, origin));
      const [endX, endY] = route[route.length - 1]!;
      setLine({ path: buildRoundedPath(route, LINE_CORNER_RADIUS), endX, endY });
      blocker.classList.add(BLOCKER_CLASS);
      ringed = blocker;
      // The first report is the observer starting, not a change.
      let isStarting = true;
      observer = new ResizeObserver(() => {
        if (isStarting) isStarting = false;
        else hide();
      });
      observer.observe(canvas);
    };

    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const card =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(BLOCKED_CARD_SELECTOR)
          : null;
      if (card === resting) return;
      hide();
      resting = card;
      if (card === null) return;
      timer = window.setTimeout(() => {
        draw(card);
      }, BLOCKER_LINE_DELAY_MS);
    };
    const onPointerLeaveOrDown = (): void => {
      resting = null;
      hide();
    };

    canvas.addEventListener("pointerover", onPointerOver);
    canvas.addEventListener("pointerleave", onPointerLeaveOrDown);
    canvas.addEventListener("pointerdown", onPointerLeaveOrDown);
    return () => {
      canvas.removeEventListener("pointerover", onPointerOver);
      canvas.removeEventListener("pointerleave", onPointerLeaveOrDown);
      canvas.removeEventListener("pointerdown", onPointerLeaveOrDown);
      hide();
    };
  }, [canvasRef]);

  if (line === null) return null;
  return (
    <svg key={line.path} className="blocker-line" aria-hidden="true">
      <path d={line.path} />
      <circle cx={line.endX} cy={line.endY} r={2.5} />
    </svg>
  );
}
