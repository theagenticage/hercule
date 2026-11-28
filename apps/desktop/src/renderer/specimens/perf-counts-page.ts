/**
 * What the counts page (perf-counts.tsx) offers the counts check
 * (scripts/perf-counts-screens.ts), which reads it in the page. The types live
 * apart from the page, so the script can import them without the browser's
 * types.
 */
import type { MutableLiveTopic } from "@hercule/contract";

/** What the probe counted, as the counts check reads it. */
export interface ProbeReading {
  /** The renders of each component since the last reset, by name. */
  readonly renders: Record<string, number>;
  /** The intervals that are running. */
  readonly intervals: number;
  /** The timeouts that will fire within a second. */
  readonly shortTimeouts: number;
  /** The timeouts that will fire later than a second from when they were set. */
  readonly longTimeouts: number;
  /** The animation frames requested and not yet run. */
  readonly frames: number;
}

/** What the page offers the counts check, as `window.perfCounts`. */
export interface PerfCountsPage {
  /** The requests the app sent, oldest first, as `METHOD /path`. */
  readonly listRequests: () => readonly string[];
  /** The requests no handler of the fake controller answers, which fail the check. */
  readonly listUnknownRequests: () => readonly string[];
  /** Returns the probe's counters and starts counting renders from zero again. */
  readonly readProbe: () => ProbeReading;
  /** Checks whether no read or write is running. */
  readonly isIdle: () => boolean;
  /**
   * Checks whether nothing moves on the page and nothing is about to: no
   * animation frame is requested, no timeout is due within a second, and no
   * animation that ends is running. An animation that never ends, such as a
   * spinner, does not count.
   */
  readonly isStill: () => boolean;
  /** Checks whether the app's socket is open with the shell's subscriptions. */
  readonly isLive: () => boolean;
  /** Sends the app an invalidation on `topic`, naming `ids`, as the controller does after a change. */
  readonly push: (topic: MutableLiveTopic, ids: readonly string[]) => void;
  /** Changes the fake controller's world in the way `change` names, before a push tells the app. */
  readonly changeWorld: (change: string) => void;
}
