/**
 * The flight that ends a hand-off: the mark of the thing handed leaves its row
 * along an arc to Work in the sidebar, which takes a small knock and a wash.
 * It starts 170ms after the hand, as the colleague takes the weight, and takes
 * 420 to 760ms by distance (see `flyToSidebarTarget`).
 */
import { flyToSidebarTarget, type SidebarFlight } from "../../app/motion/sidebar-flight";

/** How long after the hand the mark leaves its row, in milliseconds. */
const FLIGHT_DELAY_MS = 170;

/** A flight that was not drawn, for a row that is not on the page. */
const NO_FLIGHT: SidebarFlight = { cancel: () => undefined, ms: 0 };

/**
 * Flies the mark of the row `ref` to Work in the sidebar. Draws nothing, and
 * returns a flight that does nothing, when the row is not drawn (it is out of
 * the virtual list's reach) or the sidebar does not show Work. Returns the
 * flight, whose `cancel` stops it: Undo does that while the mark is in the air.
 */
export const flyHandedMarkToWork = (ref: string): SidebarFlight => {
  const mark = document.querySelector(`.ib-rows [data-ref="${CSS.escape(ref)}"] .ib-mark`);
  return mark instanceof HTMLElement
    ? flyToSidebarTarget(mark, "overview", FLIGHT_DELAY_MS)
    : NO_FLIGHT;
};
