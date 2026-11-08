import { copyCardForMotion, type SheetPlaces, type SheetRect } from "../desk";

/** The narrowest the open card is, so a small request in the narrow column opens into a sheet wide enough to read. */
const MIN_SHEET_WIDTH = 520;

/** How far the sheet keeps from the window's edges, and from the page's left and right edges. */
const EDGE_MARGIN = 16;

/** How far the sheet keeps below the top of the page, which is the top of the desk. */
const TOP_MARGIN = 12;

/** Returns where `element` is drawn in the window, as a rectangle. */
const measureElementRect = (element: HTMLElement): SheetRect => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
};

/** Returns whether `element` is drawn on the page now. */
const isOnPage = (element: HTMLElement | null): element is HTMLElement =>
  element !== null && element.isConnected && element.getClientRects().length > 0;

/**
 * Returns where the open card's sheet starts and where it stands open, in
 * window pixels.
 *
 * - The sheet starts from the visible part of `origin`, the card or place head
 *   it opened from, and its words are a detached copy of `origin`: the sheet
 *   takes the words into itself, and the page's own element must stay in the
 *   list. An origin that is not drawn (the card left the page) has no
 *   rectangle, and the sheet only fades.
 * - The sheet stands open over its card's column: its top left corner is the
 *   card's, and it is at least 520px wide. A place opens over its own surface
 *   (the width and left edge of `.inbox-place`). It is as tall as `content`,
 *   which is measured at that width, and stays inside the page and the window.
 * - `held` is where the sheet stood already. A sheet that moves to other
 *   words, or is read again as the window changes, keeps its place and is only
 *   pulled back inside the page, so a walk through the page's cards never
 *   makes the sheet jump.
 */
export const readOpenCardPlaces = (
  origin: HTMLElement | null,
  content: HTMLElement,
  held: SheetRect | null,
): SheetPlaces => {
  const drawnOrigin = isOnPage(origin) ? origin : null;
  const from = drawnOrigin === null ? null : measureElementRect(drawnOrigin);
  const surface =
    drawnOrigin?.dataset["placeRef"] === undefined
      ? null
      : drawnOrigin.closest<HTMLElement>(".inbox-place");
  const desk =
    (drawnOrigin ?? content).closest(".inbox-desk") ?? document.querySelector(".inbox-desk");
  const page = desk?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth, top: 0 };

  const width =
    held?.width ??
    Math.min(
      Math.max(MIN_SHEET_WIDTH, Math.round(surface?.offsetWidth ?? from?.width ?? MIN_SHEET_WIDTH)),
      window.innerWidth - 2 * EDGE_MARGIN,
    );
  content.style.width = `${String(width)}px`;
  const height = Math.min(content.offsetHeight, window.innerHeight - 2 * EDGE_MARGIN);

  const wantedLeft =
    held?.left ?? (surface === null ? (from?.left ?? page.left) : measureElementRect(surface).left);
  const wantedTop = held?.top ?? from?.top ?? page.top;
  return {
    origin: { rect: from, words: drawnOrigin === null ? null : copyCardForMotion(drawnOrigin) },
    destination: {
      left: Math.max(
        page.left + EDGE_MARGIN,
        Math.min(wantedLeft, page.right - width - EDGE_MARGIN),
      ),
      top: Math.max(
        page.top + TOP_MARGIN,
        Math.min(wantedTop, window.innerHeight - height - EDGE_MARGIN),
      ),
      width,
      height,
    },
  };
};
