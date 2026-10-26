import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard";

/** How long a copy button shows its result, in milliseconds, before it reads as a copy button again. */
const COPY_RESULT_MS = 1500;

/** What a copy came to: the text is on the clipboard, or the browser refused. */
export type CopyResult = "copied" | "failed";

/**
 * Returns `copy`, which puts a text on the clipboard, and `result`, what the
 * last copy came to. `result` returns to `undefined` `COPY_RESULT_MS` after
 * the copy, so a button can show a check mark or "Copy failed" for a moment
 * and then look like a copy button again.
 *
 * There is one timer: a second copy restarts it, and unmounting stops it.
 * `copy` must run inside a click handler, as `copyText` requires.
 */
export function useCopyResult(): {
  readonly result: CopyResult | undefined;
  readonly copy: (text: string) => void;
} {
  const [result, setResult] = useState<CopyResult | undefined>(undefined);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const copy = useCallback((text: string): void => {
    setResult(copyText(text) ? "copied" : "failed");
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setResult(undefined), COPY_RESULT_MS);
  }, []);
  return { result, copy };
}
