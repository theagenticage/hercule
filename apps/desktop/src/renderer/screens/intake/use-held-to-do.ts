/**
 * The To do list as Intake shows it (spec 17 §Motion). While the pointer is
 * over the list, a change the user did not make waits, and applies once the
 * pointer leaves. Otherwise the user aims at Approve on #1294, a Now row
 * arrives above it, and they approve the wrong signal. A change the user's
 * own action made applies at once.
 *
 * The same record tells whether inbox zero arrives: only when the user's own
 * action takes the last signal off the list.
 */
import { useState } from "react";
import { flushSync } from "react-dom";
import type { Signal } from "@hercule/contract";

/** The To do list as shown, and what decides it. */
export interface HeldToDo {
  /** The To do list as last read. */
  readonly toDo: ReadonlyArray<Signal>;
  /** The list the screen shows: `toDo`, less the changes held back. */
  readonly shown: ReadonlyArray<Signal>;
  /**
   * The signals the user's own action changed, each with its row in `toDo`
   * when the action ended, or `undefined` when it had none. An id stays
   * until `toDo` shows the change: the row is gone or differs.
   */
  readonly own: ReadonlyMap<string, Signal | undefined>;
  /** Whether changes the user did not make wait, because the pointer is over the list. */
  readonly holding: boolean;
  /** The view and the tab shown. */
  readonly scope: string;
  /** Whether inbox zero plays its arrival: the user's own action emptied the list just now. */
  readonly arriving: boolean;
}

/** Returns the record for a screen that opens on `toDo` in `scope`: nothing held, and no arrival. */
export const startHeldToDo = (toDo: ReadonlyArray<Signal>, scope: string): HeldToDo => ({
  toDo,
  shown: toDo,
  own: new Map(),
  holding: false,
  scope,
  arriving: false,
});

/**
 * Decides whether inbox zero arrives when the shown list goes from `before`
 * to `after`. It arrives only when the list empties and every signal that
 * left is in `ownIds`. While the list stays empty, `was` holds, so a read
 * that finds the list still empty does not stop an arrival under way.
 */
const decideArriving = (
  before: ReadonlyArray<Signal>,
  after: ReadonlyArray<Signal>,
  ownIds: ReadonlySet<string>,
  was: boolean,
): boolean => {
  if (after.length > 0) return false;
  if (before.length === 0) return was;
  return before.every((signal) => ownIds.has(signal.id));
};

/**
 * Returns `shown` with the rows of `ids` as `toDo` has them: a row `toDo`
 * no longer has leaves, a changed row is replaced, and a row `toDo` gained
 * is added at the end. The screen sorts the rows into sections, so the
 * order here does not matter.
 */
const applyChanges = (
  shown: ReadonlyArray<Signal>,
  toDo: ReadonlyArray<Signal>,
  ids: ReadonlySet<string>,
): ReadonlyArray<Signal> => {
  const current = new Map(toDo.map((signal) => [signal.id, signal]));
  const kept = shown.flatMap((signal) => {
    if (!ids.has(signal.id)) return [signal];
    const now = current.get(signal.id);
    return now === undefined ? [] : [now];
  });
  const shownIds = new Set(shown.map((signal) => signal.id));
  const gained = [...ids].flatMap((id) => {
    const now = current.get(id);
    return now === undefined || shownIds.has(id) ? [] : [now];
  });
  return [...kept, ...gained];
};

/**
 * Follows a new read of To do, `toDo`. The user's own changes that `toDo`
 * shows apply to the shown list and leave `own`. While holding, every other
 * change waits; otherwise the shown list is `toDo`.
 */
export const followToDo = (held: HeldToDo, toDo: ReadonlyArray<Signal>): HeldToDo => {
  const current = new Map(toDo.map((signal) => [signal.id, signal]));
  const applied = new Set(
    [...held.own.keys()].filter((id) => current.get(id) !== held.own.get(id)),
  );
  const own = new Map([...held.own].filter(([id]) => !applied.has(id)));
  const shown = held.holding ? applyChanges(held.shown, toDo, applied) : toDo;
  return {
    ...held,
    toDo,
    shown,
    own,
    arriving: decideArriving(held.shown, shown, applied, held.arriving),
  };
};

/** Records that the user's own action changed `signalIds`, as the last read of To do has them. */
export const registerOwnChanges = (held: HeldToDo, signalIds: ReadonlyArray<string>): HeldToDo => {
  const current = new Map(held.toDo.map((signal) => [signal.id, signal]));
  return {
    ...held,
    own: new Map([...held.own, ...signalIds.map((id) => [id, current.get(id)] as const)]),
  };
};

/** Starts holding back the changes the user did not make. */
export const holdChanges = (held: HeldToDo): HeldToDo => ({ ...held, holding: true });

/**
 * Stops holding: the shown list becomes the last read of To do in one step,
 * so its changes move as one block. A list this empties shows inbox zero
 * still, because the user did not empty it.
 */
export const releaseChanges = (held: HeldToDo): HeldToDo => ({
  ...held,
  holding: false,
  shown: held.toDo,
  arriving: decideArriving(held.shown, held.toDo, new Set(), held.arriving),
});

/**
 * Switches to `scope`, another view or tab: the list shows the last read of
 * To do, and an arrival under way stops, so coming back to the All tab shows
 * inbox zero still.
 */
const switchScope = (held: HeldToDo, scope: string): HeldToDo => ({
  ...held,
  scope,
  shown: held.toDo,
  arriving: false,
});

/** The To do list as shown, and the screen's ways to change what is held. */
export interface HeldToDoState {
  readonly shown: ReadonlyArray<Signal>;
  readonly arriving: boolean;
  /**
   * Records that the user's own action changed `signalIds`. Call it before
   * the change reaches the cache: it applies at once, so the next read of
   * To do already knows the change is the user's own.
   */
  readonly registerOwnChanges: (signalIds: ReadonlyArray<string>) => void;
  /** Called when the pointer enters the list. */
  readonly holdChanges: () => void;
  /** Called when the pointer leaves the list. */
  readonly releaseChanges: () => void;
}

/**
 * Returns To do as Intake shows it, `toDo` being the last read and `scope`
 * the view and the tab shown, as this module describes.
 */
export const useHeldToDo = (toDo: ReadonlyArray<Signal>, scope: string): HeldToDoState => {
  const [held, setHeld] = useState(() => startHeldToDo(toDo, scope));
  let next = held;
  if (next.scope !== scope) next = switchScope(next, scope);
  if (next.toDo !== toDo) next = followToDo(next, toDo);
  if (next !== held) setHeld(next);
  return {
    shown: next.shown,
    arriving: next.arriving,
    registerOwnChanges: (signalIds) => {
      // A move puts its change in the cache right after this call. Without
      // the flush, React could draw that read before this record, and take
      // the user's change for one made elsewhere.
      flushSync(() => {
        setHeld((current) => registerOwnChanges(current, signalIds));
      });
    },
    holdChanges: () => {
      setHeld(holdChanges);
    },
    releaseChanges: () => {
      setHeld(releaseChanges);
    },
  };
};
