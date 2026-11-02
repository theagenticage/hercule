/**
 * The way the Fleet page shows its machines, which the window remembers while
 * the user moves between pages. It lives in this module, not in the page's
 * state, because the page is unmounted when a machine's page opens. A new
 * window starts with the grid (spec 17 §Fleet).
 */

/** How the Machines section draws the machines: as cards or as table rows. */
export type MachineView = "grid" | "list";

let remembered: MachineView = "grid";

/** Returns the view the user last picked in this window, or `grid` when none was picked. */
export const readMachineView = (): MachineView => remembered;

/** Remembers `view` as the one the Machines section opens with next. */
export const rememberMachineView = (view: MachineView): void => {
  remembered = view;
};
