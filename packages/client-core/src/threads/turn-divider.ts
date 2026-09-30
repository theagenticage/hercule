/**
 * The divider under a thread turn (spec 14 §The thread surface): whether a
 * turn shows one, the words on it, and the line it lists for each tool item
 * when it is opened.
 */
import { formatDuration } from "./duration";
import type { ThreadItem, ThreadTurn } from "./turns";

/**
 * Checks whether a turn shows its divider. It does when:
 *
 * - the turn is `live`, so the elapsed time is shown while it runs;
 * - the turn has tool items to list;
 * - the turn ended in any way other than completing: it was stopped, it
 *   failed, or it was cut short. Such an ending is always shown, even for a
 *   turn with no items, so that no turn ends silently.
 *
 * A completed turn with no tool items shows no divider: its reply says all
 * there is to say.
 */
export const showsTurnDivider = (turn: ThreadTurn, live: boolean): boolean =>
  live || turn.items.length > 0 || turn.endState !== "completed";

/**
 * Returns the words on a turn's divider: "Working for 22s" while the turn is
 * `live`, counted from its start to `now` (milliseconds since the epoch), and
 * otherwise the words `describeTurnEnding` returns for how it ended.
 */
export const describeTurnDivider = (turn: ThreadTurn, live: boolean, now: number): string =>
  live
    ? `Working for ${formatDuration(now - Date.parse(turn.startedAt))}`
    : describeTurnEnding(turn);

/**
 * Returns the words for how a turn ended, from its end state and duration.
 * It takes a whole turn, or an `EndingBlock` from `buildThreadBlocks`:
 *
 * - "Worked for 22s" for a turn that completed;
 * - "Stopped after 22s" for a turn that was interrupted;
 * - "Failed after 22s" for a turn that failed;
 * - "Cut short" for a turn with no `turn.completed` row. Its session ended
 *   while the turn ran, so there is no end time, and "0s" would wrongly
 *   suggest the turn finished at once.
 */
export const describeTurnEnding = (turn: Pick<ThreadTurn, "endState" | "duration">): string => {
  if (turn.endState === null || turn.duration === null) return "Cut short";
  const time = formatDuration(turn.duration);
  switch (turn.endState) {
    case "completed":
      return `Worked for ${time}`;
    case "interrupted":
      return `Stopped after ${time}`;
    case "failed":
      return `Failed after ${time}`;
  }
};

/**
 * Returns the line an opened divider lists for one tool item: its verb,
 * target and result joined by " · ". A target the item did not report is
 * left out, so no separator is doubled.
 */
export const describeThreadItem = (item: ThreadItem): string =>
  [item.verb, item.target, item.result].filter((part) => part !== "").join(" · ");
