import { useEffect, useState } from "react";

/**
 * Returns `value` once it has held still for `quietMs`, and the value before
 * until then. A value that changes again within the quiet restarts the wait.
 * It sets a timer only while the value is changing, so a screen that is not
 * being typed into does no work.
 */
export function useQuietValue<T>(value: T, quietMs: number): T {
  const [quiet, setQuiet] = useState(value);
  useEffect(() => {
    if (Object.is(value, quiet)) return;
    const timer = setTimeout(() => {
      setQuiet(value);
    }, quietMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, quiet, quietMs]);
  return quiet;
}
