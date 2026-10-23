/**
 * The parts of the desktop sidebar's lists that the group-based sidebar
 * (`buildGroupSidebar`) still shares: which sections the user expanded, the
 * shape of the Waiting on you section, and the length of the Done shelf.
 */
import type { Waiting } from "../waiting";

/** Which sections the user has expanded to show every thread. */
export interface ExpandedSections {
  /** Whether Waiting on you shows every entry. */
  readonly waiting: boolean;
  /** The expanded projects, by id. `null` stands for the threads that belong to no project. */
  readonly projectIds: ReadonlySet<string | null>;
}

/** The Waiting on you section. */
export interface WaitingSection {
  /** The threads and assistants it shows, newest activity first. */
  readonly rows: readonly Waiting[];
  /** How many entries it hides: the number on its "more" row, or 0 for none. */
  readonly hiddenCount: number;
}

/** How many done groups the Done shelf shows when the user opens it. */
export const DONE_SHELF_LIMIT = 10;

/** How many more done groups each press of the shelf's "Show 25 more" row shows. */
export const DONE_SHELF_STEP = 25;
