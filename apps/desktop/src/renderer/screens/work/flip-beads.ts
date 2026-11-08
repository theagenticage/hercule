/**
 * The glide of the beads on the folded lines of Initiative rows. When a Task
 * changes stage, its bead is a new element in another cell, and the beads
 * beside it close up or make room: without this they would jump.
 *
 * A bead stands inside its line, and the line has a key of its own in
 * `flipBoard` and glides as a whole. Moving the beads by the same key would
 * move them twice, so a bead is measured from the top left of its line: the
 * line's own movement cancels, and what is left is how the bead moved within
 * the line.
 */
import {
  findBody,
  isMotionReduced,
  measureLayoutRect,
  trackBody,
  type SpringName,
  type Velocity,
} from "../../app/motion";

const BEAD_SELECTOR = "[data-bead-task-id]";

/** A move within the line shorter than this many pixels is not drawn. */
const SMALLEST_MOVE = 0.5;

/** Where a bead stood in its line, and how it moved, before or after a change. */
interface BeadPlace {
  readonly element: HTMLElement;
  /** The center of the bead, in pixels right of the top left of its line. */
  readonly x: number;
  /** The center of the bead, in pixels below the top left of its line. */
  readonly y: number;
  /** The scale the bead shows (a held bead is 1.5). */
  readonly scale: number;
  readonly velocity: Velocity | undefined;
}

/** The beads of a board by the id of their Task, as `measureBeads` found them. */
export type BeadPlaces = ReadonlyMap<string, BeadPlace>;

/**
 * Measures every bead under `scroller` where it looks now, including a
 * movement still under way, by the id of its Task. Reads the page once.
 *
 * With `isLayout`, a bead is measured where the layout puts it, with its own
 * offset and scale taken away: the place it will glide to.
 */
export const measureBeads = (scroller: ParentNode, isLayout: boolean): BeadPlaces => {
  const places = new Map<string, BeadPlace>();
  const lines = new Map<Element, DOMRect>();
  for (const bead of scroller.querySelectorAll<HTMLElement>(BEAD_SELECTOR)) {
    const taskId = bead.dataset["beadTaskId"] ?? "";
    const line = bead.closest("[data-fold-row]");
    if (line === null || places.has(taskId)) continue;
    let lineRect = lines.get(line);
    if (lineRect === undefined) {
      lineRect = line.getBoundingClientRect();
      lines.set(line, lineRect);
    }
    const rect = isLayout ? measureLayoutRect(bead) : bead.getBoundingClientRect();
    const body = findBody(bead);
    places.set(taskId, {
      element: bead,
      x: rect.left + rect.width / 2 - lineRect.left,
      y: rect.top + rect.height / 2 - lineRect.top,
      scale: body?.values.s ?? 1,
      velocity: body?.velocity,
    });
  }
  return places;
};

/**
 * Glides every bead that moved within its line from where it looked `before`
 * to where it stands `after`, on `spring`. A bead that is a new element, such
 * as one that changed stage, takes over the offset, the scale and the speed of
 * the element it replaces, so a bead let go in your hand comes down to its
 * stage from where the hand left it. Beads that are only in one of the two
 * are left alone. Under Reduce motion a bead that moved fades in where it
 * stands. Call it right after the change, once both are measured.
 */
export const glideBeads = (before: BeadPlaces, after: BeadPlaces, spring: SpringName): void => {
  const isReduced = isMotionReduced();
  for (const [taskId, now] of after) {
    const was = before.get(taskId);
    if (was === undefined) continue;
    const isReplaced = was.element !== now.element;
    if (isReplaced && !was.element.isConnected) findBody(was.element)?.clear();
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    const body = trackBody(now.element);
    const hasOffset = body.values.x !== 0 || body.values.y !== 0;
    const isMoved = Math.abs(dx) >= SMALLEST_MOVE || Math.abs(dy) >= SMALLEST_MOVE;
    if (!isMoved && !hasOffset && was.scale === 1) continue;
    if (isReduced) {
      if (isMoved) {
        body.set({ o: 0 });
        body.to({ o: 1 }, "travel");
      }
      continue;
    }
    body.relocate(dx, dy, isReplaced ? was.velocity : undefined);
    if (isReplaced) body.set({ s: was.scale });
    body.to({ x: 0, y: 0, s: 1 }, spring);
  }
};
