import { useEffect, useState } from "react";

/** How long the first words of a page take to fade in, in milliseconds. */
const ARRIVAL_MS = 1_200;

/**
 * Returns whether a page's first words are still fading in, so the page can
 * mark itself as arriving.
 *
 * The first words are the ones that come in when the page opens without any
 * (`hadNoWords` on the first render). A page that opens with its words already
 * there, such as one drawn from the cache, never arrives. The answer is true
 * from the moment `hasWords` becomes true, for `ARRIVAL_MS`, and false before
 * and after.
 */
export function useFirstArrival(hadNoWords: boolean, hasWords: boolean): boolean {
  const [startedWithoutWords] = useState(hadNoWords);
  const [isOver, setIsOver] = useState(false);
  useEffect(() => {
    if (!startedWithoutWords || !hasWords) return;
    const timer = setTimeout(() => {
      setIsOver(true);
    }, ARRIVAL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [startedWithoutWords, hasWords]);
  return startedWithoutWords && hasWords && !isOver;
}
