import { useEffect, useState, type JSX } from "react";
import "./sync-marker.css";

/** How long syncing must last before the marker shows, in milliseconds. A sync that ends sooner never shows it. */
const SHOW_AFTER_MS = 400;

/**
 * Renders the free space of a header (the `.spacer` it replaces) with the
 * word "Syncing…" in it while `syncing` is true.
 *
 * - The word appears only once `syncing` has been true for 400 ms, so a quick
 *   sync flashes nothing. It then fades in once.
 * - The word goes at once when `syncing` turns false.
 * - The `role="status"` element is there from the start, empty, so a screen
 *   reader that watches it announces the word when it arrives.
 */
export function SyncMarker({ syncing }: { readonly syncing: boolean }): JSX.Element {
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setWaited(true), SHOW_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setWaited(false);
    };
  }, [syncing]);

  return (
    <span className="spacer sync-slot">
      <span role="status" className="sync-status">
        {syncing && waited ? <span className="sync-text">Syncing…</span> : null}
      </span>
    </span>
  );
}
