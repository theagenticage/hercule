/**
 * A turn's duration or a live turn's elapsed time, as the thread surface's
 * "Worked for" / "Working for" dividers read it: `31s`, `12m 4s`, `1h 4m`.
 * Seconds are dropped once there is an hour to show, the way a stopwatch a
 * reader glances at rather than reads closely is usually written.
 */
export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};
