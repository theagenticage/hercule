/**
 * Returns the view-transition name that a machine's card on the Fleet page and
 * the head of its own page both carry, so the browser can move the card's
 * icon and name into the head when the user opens the machine. A name must be
 * unique on the page at any moment, hence the runner id in it.
 */
export const buildMachineTransitionName = (runnerId: string): string => `fleet-machine-${runnerId}`;

/**
 * The type of the view transition that runs between the Fleet page and a
 * machine's page. `machine-transition.css` styles the transition by this
 * type, so no other view transition picks up its rules.
 */
export const MACHINE_TRANSITION_TYPE = "fleet-machine";

/** The two places a navigation moves between, as far as the transition cares. */
interface NavigationPlaces {
  readonly fromLocation?: { readonly pathname: string };
  readonly toLocation: { readonly pathname: string };
}

const FLEET_PAGE = /^\/fleet\/?$/;
const MACHINE_PAGE = /^\/fleet\/[^/]+\/?$/;

/**
 * Decides which view transition types a navigation runs with, for the
 * router's `defaultViewTransition`. Returns `[MACHINE_TRANSITION_TYPE]` when
 * the navigation moves from the Fleet page to a machine's page or back, and
 * `false` for every other navigation and while Reduce motion is on, which
 * the router reads as "start no view transition".
 *
 * The router asks on every navigation, whatever caused it: a card pressed, the
 * header's Fleet crumb, or the Back and Forward commands. That is why the rule
 * lives here and not at the links.
 */
export const decideMachineTransitionTypes = (
  { fromLocation, toLocation }: NavigationPlaces,
  isMotionReduced: boolean,
): string[] | false => {
  if (isMotionReduced || fromLocation === undefined) return false;
  const from = fromLocation.pathname;
  const to = toLocation.pathname;
  const opens = FLEET_PAGE.test(from) && MACHINE_PAGE.test(to);
  const returns = MACHINE_PAGE.test(from) && FLEET_PAGE.test(to);
  return opens || returns ? [MACHINE_TRANSITION_TYPE] : false;
};
