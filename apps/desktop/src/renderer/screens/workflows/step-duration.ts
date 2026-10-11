/**
 * How long a step ran, as a run's page shows it on a node's card and on the
 * step timeline, kept current by the age clock while the step runs.
 */
import { formatDuration, formatElapsed, measureElapsed } from "@hercule/client-core";
import { useDurationText } from "../../app/age-clock";

/**
 * Returns how long a step that started at `startedAt` ran until
 * `finishedAt`, or has run up to now while `finishedAt` is `undefined`.
 *
 * - A step that has ended shows its duration as the web app does
 *   (`formatElapsed`): "40ms", "4.3s", "5m 0s".
 * - A running step counts in whole seconds (`formatDuration`): "4s",
 *   "29m 12s". The age clock wakes once a second for it, so tenths would
 *   show a value that is already out of date.
 */
export const useStepDuration = (startedAt: string, finishedAt: string | undefined): string =>
  useDurationText(startedAt, finishedAt === undefined, (now) => {
    const elapsed = measureElapsed(startedAt, finishedAt, now) ?? 0;
    return finishedAt === undefined ? formatDuration(elapsed) : formatElapsed(elapsed);
  });
