import { useState } from "react";

/**
 * Holds an on-off flag that this browser tab keeps until it closes, stored in
 * `sessionStorage` under `key`. Returns the flag, which starts `false` when
 * nothing is stored, and a function that flips it and stores the new value.
 *
 * A fold that stays open across page loads uses it. Storage errors are
 * caught: a browser that denies storage still shows the fold, and only
 * forgets whether it was open.
 */
export function useTabFlag(key: string): readonly [boolean, () => void] {
  const [flag, setFlag] = useState(() => {
    try {
      return sessionStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  });
  const toggle = (): void => {
    const next = !flag;
    setFlag(next);
    try {
      sessionStorage.setItem(key, String(next));
    } catch {
      // Ignore the error: losing this state is harmless.
    }
  };
  return [flag, toggle];
}
