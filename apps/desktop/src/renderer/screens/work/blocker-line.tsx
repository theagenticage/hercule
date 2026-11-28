import { useEffect, useState, type JSX, type RefObject } from "react";
import {
  buildRoundedPath,
  frameRoute,
  LINE_CORNER_RADIUS,
  routeBlockerLine,
  type Box,
  type LineFrame,
} from "./blocker-line-geometry";
import "./blocker-line.css";

/** How long the pointer rests on a blocked card before the line to its blocker is drawn. */
export const BLOCKER_LINE_DELAY_MS = 240;

/** The class a card wears while a line points at it. */
const BLOCKER_CLASS = "is-blocker";

/** Finds a blocked card by what it carries: its state and the id of the Task that blocks it. */
const BLOCKED_CARD_SELECTOR = '.desk-card[data-state="blocked"][data-blocked-by]';

/** The class of the line's SVG. */
const LINE_CLASS = "blocker-line";

/** Room around the route inside the SVG, in pixels: half the stroke and the end dot's radius, rounded up. */
const FRAME_PADDING = 4;

/** A line to draw: where its SVG stands, its path, and the point where it ends on the blocker, in the SVG's own coordinates. */
interface DrawnLine {
  readonly frame: Pick<LineFrame, "left" | "top" | "width" | "height">;
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
  for (const card of canvas.querySelectorAll<HTMLElement>(
    `[data-card-id="${CSS.escape(taskId)}"]`,
  )) {
    if (card === except) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return card;
  }
  return null;
};

/** Returns whether `record` only adds or removes the line's own SVG, which is no change of the board. */
const isOwnChange = (record: MutationRecord): boolean => {
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return (
    nodes.length > 0 &&
    nodes.every((node) => node instanceof Element && node.classList.contains(LINE_CLASS))
  );
};

/**
 * Draws the thin line from a blocked card to the card that blocks it, over the
 * board, while the pointer rests on the blocked card, and rings the blocker.
 * It explains and holds no structure: nothing is drawn when the blocker is
 * not on the board, and the line goes as soon as the pointer leaves the card,
 * presses, the board changes size, or a card is added, removed or moved (the
 * line would point at the old place).
 *
 * `canvasRef` is the board's canvas, which scrolls with the cards and is the
 * line's own positioned ancestor, so the line moves with the cards. One
 * listener on the canvas serves every card. At rest nothing runs: no timer, no
 * observer, and no measuring. A card is measured only when its line is drawn,
 * and only while it shows do two observers watch the board. The line's SVG is
 * as large as the line, not as large as the board. The line fades in, and
 * under Reduce motion it simply appears.
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
    let sizeObserver: ResizeObserver | null = null;
    let changeObserver: MutationObserver | null = null;

    const hide = (): void => {
      window.clearTimeout(timer);
      timer = undefined;
      sizeObserver?.disconnect();
      sizeObserver = null;
      changeObserver?.disconnect();
      changeObserver = null;
      ringed?.classList.remove(BLOCKER_CLASS);
      ringed = null;
      setLine(null);
    };

    const draw = (card: HTMLElement): void => {
      const blockerId = card.dataset["blockedBy"];
      const blocker = blockerId === undefined ? null : findCardOnBoard(canvas, blockerId, card);
      if (blocker === null || !card.isConnected) return;
      const origin = canvas.getBoundingClientRect();
      const { points, ...frame } = frameRoute(
        routeBlockerLine(measureBox(card, origin), measureBox(blocker, origin)),
        FRAME_PADDING,
      );
      const [endX, endY] = points[points.length - 1]!;
      setLine({ frame, path: buildRoundedPath(points, LINE_CORNER_RADIUS), endX, endY });
      blocker.classList.add(BLOCKER_CLASS);
      ringed = blocker;
      // The first report is the observer starting, not a change.
      let isStarting = true;
      sizeObserver = new ResizeObserver(() => {
        if (isStarting) isStarting = false;
        else hide();
      });
      sizeObserver.observe(canvas);
      changeObserver = new MutationObserver((records) => {
        if (!records.every(isOwnChange)) hide();
      });
      changeObserver.observe(canvas, { childList: true, subtree: true });
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
    <svg key={line.path} className={LINE_CLASS} style={line.frame} aria-hidden="true">
      <path d={line.path} />
      <circle cx={line.endX} cy={line.endY} r={2.5} />
    </svg>
  );
}
