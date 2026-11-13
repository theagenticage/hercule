import { useEffect, useState } from "react";

/** How long a thing must stay current before the pane reads from its source, in milliseconds. */
const REST_DELAY_MS = 250;

/**
 * How far the pane may go in reading the current thing:
 *
 * - `hidden`: the pane is not showing, so nothing is read.
 * - `walking`: the thing became current a moment ago. Only the cheap read of
 *   its record is made, and no answer is given.
 * - `stale`: the thing has rested, but the pane still draws the thing
 *   before's record. The blocks are read from the source (they do not need
 *   the record), but no ask is read and no answer is given, because both
 *   would go to the wrong thing.
 * - `rested`: the thing has been current long enough, and its record is the
 *   one drawn: every read is made.
 */
export type ReadGate = "hidden" | "walking" | "stale" | "rested";

/**
 * Returns the gate of the thing `id`. `isActive` is false while the pane is
 * not showing, and `isStale` is true while the record drawn is the thing
 * before's.
 *
 * Holding J or K walks down the list, and the gate keeps every read that goes
 * to the source from being made for each row the focus passes. The delay is one
 * trailing timer: a step to another thing, the pane hiding and unmounting each
 * cancel it and start nothing. The remembered thing is never reset, because
 * that would render once per step for nothing: comparing it with `id` already
 * gives false for every other thing.
 */
export const useReadGate = (id: string, isActive: boolean, isStale: boolean): ReadGate => {
  const [restedId, setRestedId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setTimeout(() => {
      setRestedId(id);
    }, REST_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [id, isActive]);
  if (!isActive) return "hidden";
  if (restedId !== id) return "walking";
  return isStale ? "stale" : "rested";
};
