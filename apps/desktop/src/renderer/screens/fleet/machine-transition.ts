/**
 * Returns the view-transition name that a machine's card on the Fleet page and
 * the head of its own page both carry, so the browser can move the card's
 * icon and name into the head when the user opens the machine. A name must be
 * unique on the page at any moment, hence the runner id in it.
 */
export const buildMachineTransitionName = (runnerId: string): string => `fleet-machine-${runnerId}`;
