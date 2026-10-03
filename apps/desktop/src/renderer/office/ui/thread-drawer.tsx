/**
 * The thread drawer: the app's real thread screen, sliding in from the
 * right over the Office, so the user reads and answers a thread while the
 * Office stays alive on the left.
 *
 * The drawer is open while `drawer` is set and a thread is selected. The
 * thread need not have a colleague in the Office: a thread opened from the
 * sidebar may be asleep. Selecting another colleague with the drawer open
 * shows that colleague's thread. After the drawer closes, it keeps the last
 * thread drawn until it has slid away, then lets it go.
 */
import { Suspense, useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { ThreadScreen } from "../../screens/thread/thread-screen";
import { readOffice, subscribeOffice, type OfficeState } from "../office-store";

/** Milliseconds the drawer keeps its thread after closing: longer than its slide, `--dur-3`. */
const RELEASE_DELAY = 400;

/** Returns the thread id the drawer shows in `state`, or null when the drawer is closed. */
export function findDrawerThreadId(state: OfficeState): string | null {
  return state.drawer ? state.selectedId : null;
}

/** Renders the thread drawer, sliding in from the right while the store's `drawer` field is set. */
export function ThreadDrawer(): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const threadId = findDrawerThreadId(state);
  const open = threadId !== null;
  const [shownId, setShownId] = useState(threadId);
  if (open && threadId !== shownId) setShownId(threadId);
  // A timer rather than `transitionend`: with Reduce motion on, the slide
  // takes no time and no transition event fires.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setShownId(null), RELEASE_DELAY);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <aside className="office-drawer" data-open={open} inert={!open} aria-label="Thread">
      {shownId === null ? null : (
        <div className="office-drawer-thread">
          <Suspense fallback={null}>
            <ThreadScreen key={shownId} sessionId={shownId} />
          </Suspense>
        </div>
      )}
    </aside>
  );
}
