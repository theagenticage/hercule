import { useEffect, useState } from "react";

/** How long a thing must stay current before the pane reads from its source, in milliseconds. */
const REST_DELAY_MS = 250;

/**
 * Returns true once the thing `id` has been current, with the pane active, for
 * `REST_DELAY_MS`. The pane gates every read that goes to the source of the
 * thing (its blocks, the full read of its current ask) on this, so walking down
 * the list with J and K does not make those reads for every row the focus
 * passes.
 *
 * The delay is one trailing timer. A step to another thing, the pane hiding
 * and unmounting each cancel it and start nothing. The remembered thing is
 * never reset, because that would render once per step for nothing: comparing
 * it with `id` already gives false for every other thing.
 */
export const useRestedThing = (id: string, isActive: boolean): boolean => {
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
  return isActive && restedId === id;
};
