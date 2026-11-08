/**
 * When the changes of the morning replay start. The replay itself is planned
 * by `planMorningReplay` in client-core; this is only its clock.
 */

/** How long after the board is drawn the first change starts, in milliseconds. */
export const REPLAY_LEAD_MS = 300;

/** How far apart the changes start, and how long a change's words stay on the toolbar's line, in milliseconds. */
export const REPLAY_GAP_MS = 1500;

/**
 * Returns when each change of the replay starts waiting for a still hand, in
 * milliseconds after the board is drawn: the first after `REPLAY_LEAD_MS`, the
 * next ones `REPLAY_GAP_MS` apart. `playedKeys` is the keys of the changes, oldest
 * first (`MorningReplay.playedKeys`). Each change then still waits for the hand, so
 * a change can start later than this, and the ones after it do not wait for it.
 */
export const buildReplayDelays = (playedKeys: readonly string[]): ReadonlyMap<string, number> =>
  new Map(playedKeys.map((key, index) => [key, REPLAY_LEAD_MS + index * REPLAY_GAP_MS]));
