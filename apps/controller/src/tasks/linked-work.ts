/**
 * The rules for what a Task's linked things count as, and for which change of
 * a linked thing is a fact (spec 09). They are pure: the Task service reads
 * the states and writes the facts.
 */
import type { EntityLifecycle } from "@hercule/contract";
import type { LinkedEntityState } from "./linked-entities";

/** How many of a Task's links are still open, and how many are completed. */
export interface LinkedWorkCounts {
  /** Links to work that is open, or cannot be read, so cannot be called finished. */
  readonly openLinks: number;
  readonly completedLinks: number;
}

/**
 * Returns how one link counts. Each link falls to the first case that fits:
 *
 * 1. A context kind, or a ref with no record and no declared kind (`undefined`):
 *    neither, because it is not a piece of work.
 * 2. Work with no record, a partial record, no known lifecycle, or a
 *    thing nobody can read now: open, because what cannot be read cannot be
 *    called finished.
 * 3. Readable work that is open: open.
 * 4. Readable work that is completed: completed.
 * 5. Readable work that is abandoned: neither. It was closed without being
 *    done, so it holds nothing up and proves nothing.
 *
 * The rules read the stored record, so a record whose kind has left the
 * catalog is still counted.
 */
export const classifyLink = (
  state: LinkedEntityState | undefined,
): "open" | "completed" | "neither" => {
  if (state === undefined || state.classification === "context") return "neither";
  if (!state.isFullRecord || state.lifecycle === null || !state.isReadable) return "open";
  if (state.lifecycle === "open") return "open";
  return state.lifecycle === "completed" ? "completed" : "neither";
};

/**
 * Counts a Task's links by `classifyLink`. `states` has one entry per link, in
 * any order, and `undefined` for a link the port returned nothing for.
 */
export const countLinkedWork = (
  states: ReadonlyArray<LinkedEntityState | undefined>,
): LinkedWorkCounts => {
  let openLinks = 0;
  let completedLinks = 0;
  for (const state of states) {
    const counted = classifyLink(state);
    if (counted === "open") openLinks += 1;
    else if (counted === "completed") completedLinks += 1;
  }
  return { openLinks, completedLinks };
};

/** Returns true when the two counts are not the same. */
export const haveLinkedWorkCountsChanged = (
  left: LinkedWorkCounts,
  right: LinkedWorkCounts,
): boolean => left.openLinks !== right.openLinks || left.completedLinks !== right.completedLinks;

/** The lifecycles a fact carries: the one now, and the one it replaces. */
export interface FactLifecycles {
  readonly lifecycle: EntityLifecycle;
  /** Null when the thing is only just linked or observed. */
  readonly previousLifecycle: EntityLifecycle | null;
}

/**
 * Decides whether a change of one linked thing is a fact for a Task that links
 * it, and what the fact says. Returns `undefined` when it is not. `before` and
 * `now` are the thing's state around one write, and `countsChanged` says
 * whether the Task's counts differ across it. The first reason that fits wins,
 * so a Task gets at most one fact per thing and write:
 *
 * 1. The thing had no lifecycle before and has one now: first observation,
 *    `previousLifecycle` is null.
 * 2. The lifecycle changed: `previousLifecycle` is the old one.
 * 3. The thing's own readability, completeness or classification changed, and
 *    `countsChanged`: `previousLifecycle` is the lifecycle it keeps. This is
 *    how a completed link that reads again can land a card.
 *
 * A change of anything else (a title, an owner, a status, another link) never
 * is a fact, and a context record never has one.
 */
export const decideFactLifecycles = (
  before: LinkedEntityState | undefined,
  now: LinkedEntityState | undefined,
  countsChanged: boolean,
): FactLifecycles | undefined => {
  if (now === undefined || now.classification !== "work" || now.lifecycle === null) {
    return undefined;
  }
  if (before === undefined || before.lifecycle === null) {
    return { lifecycle: now.lifecycle, previousLifecycle: null };
  }
  const previous = before.lifecycle;
  if (previous !== now.lifecycle) return { lifecycle: now.lifecycle, previousLifecycle: previous };
  const itselfChanged =
    before.isReadable !== now.isReadable ||
    before.isFullRecord !== now.isFullRecord ||
    before.classification !== now.classification;
  return itselfChanged && countsChanged
    ? { lifecycle: now.lifecycle, previousLifecycle: now.lifecycle }
    : undefined;
};
