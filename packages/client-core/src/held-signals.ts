/**
 * The signals Intake's list shows, which can lag the last read (spec 17
 * §Motion). While the pointer is over the list, a change the user did not
 * make waits, and applies once the pointer leaves. Otherwise the user aims
 * at Approve on #1294, a Now row arrives above it, and they approve the
 * wrong signal. A change the user's own action made applies at once.
 *
 * The same record tells whether inbox zero arrives: only when the user's own
 * action takes the last signal off the list.
 */
import type { Signal } from "@hercule/contract";

/** The signals a list shows, and what decides them. */
export interface HeldSignals {
  /** The list's signals as last read, in the order the list shows them. */
  readonly listed: ReadonlyArray<Signal>;
  /** The signals the list shows: `listed`, less the changes held back. */
  readonly shown: ReadonlyArray<Signal>;
  /**
   * The signals the user's own action changes, each with its row in
   * `listed` when the action started. An id stays until `listed` shows the
   * change: the row is gone or differs.
   */
  readonly ownChanges: ReadonlyMap<string, Signal>;
  /** Whether changes the user did not make wait, because the pointer is over the list. */
  readonly holding: boolean;
  /** What the list shows, such as the view, the tab and the pages read. */
  readonly scope: string;
  /** Whether inbox zero plays its arrival: the user's own action emptied the list just now. */
  readonly arriving: boolean;
}

/** Returns the record for a list that opens on `listed` in `scope`: nothing held, and no arrival. */
export const startHeldSignals = (listed: ReadonlyArray<Signal>, scope: string): HeldSignals => ({
  listed,
  shown: listed,
  ownChanges: new Map(),
  holding: false,
  scope,
  arriving: false,
});

/**
 * Decides whether inbox zero arrives when the shown list goes from `before`
 * to `after`. It arrives only when the list empties and every signal that
 * left is in `ownIds`. While the list stays empty, `wasArriving` holds, so a
 * read that finds the list still empty does not stop an arrival under way.
 */
const decideArriving = (
  before: ReadonlyArray<Signal>,
  after: ReadonlyArray<Signal>,
  ownIds: ReadonlySet<string>,
  wasArriving: boolean,
): boolean => {
  if (after.length > 0) return false;
  if (before.length === 0) return wasArriving;
  return before.every((signal) => ownIds.has(signal.id));
};

/**
 * Returns what the list shows once the user's own changes to `ids` apply
 * while other changes wait. When every changed row left `listed`, those
 * rows leave `shown` and nothing else moves. When a changed row stays in
 * `listed`, such as a signal snoozed again to another day in Later, the
 * list shows `listed` whole: the user's own action is moving rows anyway,
 * and placing one fresh row among held ones could break the order the
 * list's sections are drawn in.
 */
const applyChanges = (
  shown: ReadonlyArray<Signal>,
  listed: ReadonlyArray<Signal>,
  ids: ReadonlySet<string>,
): ReadonlyArray<Signal> =>
  listed.some((signal) => ids.has(signal.id))
    ? listed
    : shown.filter((signal) => !ids.has(signal.id));

/**
 * Follows a new read of the list, `listed`. The user's own changes that
 * `listed` shows apply and leave `ownChanges`. While holding, every other
 * change waits. Otherwise the shown list is `listed`.
 */
export const followListedSignals = (
  held: HeldSignals,
  listed: ReadonlyArray<Signal>,
): HeldSignals => {
  const current = new Map(listed.map((signal) => [signal.id, signal]));
  const applied = new Set(
    [...held.ownChanges].filter(([id, was]) => current.get(id) !== was).map(([id]) => id),
  );
  const ownChanges = new Map([...held.ownChanges].filter(([id]) => !applied.has(id)));
  const shown = held.holding ? applyChanges(held.shown, listed, applied) : listed;
  return {
    ...held,
    listed,
    shown,
    ownChanges,
    arriving: decideArriving(held.shown, shown, applied, held.arriving),
  };
};

/**
 * Records that the user's own action changes `signalIds`, as `listed` has
 * them now. An id the list does not hold is left out: no read of this list
 * can show its change.
 */
export const recordOwnChanges = (
  held: HeldSignals,
  signalIds: ReadonlyArray<string>,
): HeldSignals => {
  const current = new Map(held.listed.map((signal) => [signal.id, signal]));
  const recorded = signalIds.flatMap((id) => {
    const signal = current.get(id);
    return signal === undefined ? [] : [[id, signal] as const];
  });
  if (recorded.length === 0) return held;
  return { ...held, ownChanges: new Map([...held.ownChanges, ...recorded]) };
};

/**
 * Drops the user's own changes to `signalIds` that no read has shown yet,
 * because the action failed or the controller left those signals alone. A
 * later read that changes them is then a change made elsewhere.
 */
export const dropOwnChanges = (
  held: HeldSignals,
  signalIds: ReadonlyArray<string>,
): HeldSignals => {
  const dropped = new Set(signalIds);
  if (![...held.ownChanges.keys()].some((id) => dropped.has(id))) return held;
  return { ...held, ownChanges: new Map([...held.ownChanges].filter(([id]) => !dropped.has(id))) };
};

/**
 * Starts or stops holding back the changes the user did not make. Stopping
 * shows the last read in one step, so its changes move as one block. A list
 * this empties shows inbox zero still, because the user did not empty it.
 */
export const updateHolding = (held: HeldSignals, holding: boolean): HeldSignals => {
  if (held.holding === holding) return held;
  if (holding) return { ...held, holding };
  return {
    ...held,
    holding,
    shown: held.listed,
    arriving: decideArriving(held.shown, held.listed, new Set(), held.arriving),
  };
};

/**
 * Switches to `scope`, another view, tab or page count, whose last read is
 * `listed`. The list shows `listed`, and an arrival under way stops, so
 * coming back to To do shows inbox zero still. An own change stays
 * recorded only while `listed` still has its row as it was: a page of
 * Later that loads while the user's snooze waits for its answer must not
 * make that snooze wait under the pointer.
 */
export const switchHeldScope = (
  held: HeldSignals,
  listed: ReadonlyArray<Signal>,
  scope: string,
): HeldSignals => {
  const current = new Map(listed.map((signal) => [signal.id, signal]));
  return {
    ...startHeldSignals(listed, scope),
    ownChanges: new Map([...held.ownChanges].filter(([id, was]) => current.get(id) === was)),
    holding: held.holding,
  };
};
