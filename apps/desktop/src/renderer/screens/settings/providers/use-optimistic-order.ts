import { useRef, useState } from "react";

/** Returns `keys` with the key at `from` moved to `to`, both clamped into the list. */
const moveKey = (keys: readonly string[], from: number, to: number): string[] => {
  const moved = [...keys];
  const [key] = moved.splice(from, 1);
  if (key === undefined) return moved;
  moved.splice(Math.max(0, Math.min(to, moved.length)), 0, key);
  return moved;
};

/**
 * Keeps a list's order for the user's own moves: a drag or an Alt+arrow
 * shows its result at once, though the saved order only arrives with the
 * controller's answer. `savedKeys` is the order the controller holds. The
 * order the user made is dropped when the list's keys are no longer the same
 * set, because the list then changed under it.
 *
 * Returns:
 *
 * - `keys`, the keys in the order to draw them: the order the user just made
 *   while a save runs, else the saved one;
 * - `move(key, toIndex, save)`, which moves `key` to position `toIndex` (0 is
 *   the top), draws the new order at once, and calls `save` with the same
 *   move; what `save` resolves with is ignored. Once every save that is running has finished, the drawn order goes
 *   back to the saved one, which by then holds the move, or does not when the
 *   save failed. A move to where the key already is does nothing, and a key
 *   the list does not hold is ignored.
 */
export function useOptimisticOrder(savedKeys: readonly string[]) {
  const [made, setMade] = useState<readonly string[] | null>(null);
  const saving = useRef(0);
  const sameSet =
    made !== null &&
    made.length === savedKeys.length &&
    made.every((key) => savedKeys.includes(key));
  const keys = sameSet ? made : savedKeys;

  const move = async (
    key: string,
    toIndex: number,
    save: () => Promise<unknown>,
  ): Promise<void> => {
    const from = keys.indexOf(key);
    if (from === -1 || from === Math.max(0, Math.min(toIndex, keys.length - 1))) return;
    setMade(moveKey(keys, from, toIndex));
    saving.current += 1;
    try {
      await save();
    } finally {
      saving.current -= 1;
      if (saving.current === 0) setMade(null);
    }
  };
  return { keys, move };
}
