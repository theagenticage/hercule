import { useState } from "react";
import type { Signal } from "@hercule/contract";
import {
  dropOwnChanges,
  followListedSignals,
  recordOwnChanges,
  startHeldSignals,
  switchHeldScope,
  updateHolding,
} from "@hercule/client-core";

/** The signals Intake's list shows, and the screen's ways to mark the user's own changes. */
export interface HeldSignalsState {
  /** The signals the list shows, in the order of `listed`, less the changes held back. */
  readonly shown: ReadonlyArray<Signal>;
  /** Whether inbox zero plays its arrival: the user's own action emptied the list just now. */
  readonly arriving: boolean;
  /**
   * Records that the user's own action changes `signalIds`. Call it when the
   * action starts, before it is sent. The controller pushes the change as
   * soon as it makes it, so the read that push starts can come before the
   * action's answer, and must already know the change is the user's own.
   */
  readonly registerOwnChanges: (signalIds: ReadonlyArray<string>) => void;
  /**
   * Forgets the changes to `signalIds` that the action did not make after
   * all, because it failed or the controller left those signals alone.
   */
  readonly forgetOwnChanges: (signalIds: ReadonlyArray<string>) => void;
}

/**
 * Returns the signals Intake's list shows, as `held-signals` in client-core
 * describes. `listed` is the list's last read, in the order the list shows
 * it, and keeps its identity until the read changes. `scope` names what
 * the list shows, such as the view, the tab and the pages read. `holding` is set while the changes the user did not
 * make wait: while the pointer is over the list, or a menu opened from it.
 */
export const useHeldSignals = (
  listed: ReadonlyArray<Signal>,
  scope: string,
  holding: boolean,
): HeldSignalsState => {
  const [held, setHeld] = useState(() => startHeldSignals(listed, scope));
  let next = held;
  if (next.scope !== scope) next = switchHeldScope(next, listed, scope);
  if (next.listed !== listed) next = followListedSignals(next, listed);
  next = updateHolding(next, holding);
  if (next !== held) setHeld(next);
  return {
    shown: next.shown,
    arriving: next.arriving,
    registerOwnChanges: (signalIds) => {
      setHeld((current) => recordOwnChanges(current, signalIds));
    },
    forgetOwnChanges: (signalIds) => {
      setHeld((current) => dropOwnChanges(current, signalIds));
    },
  };
};
