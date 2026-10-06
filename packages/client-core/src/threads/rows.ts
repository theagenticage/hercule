/**
 * How a session is shown as a row in the sidebar and on All sessions.
 * `activityAt` stays a raw timestamp: formatting "how long ago" needs a clock,
 * and only the caller should read one.
 */
import type { ProviderInstance, Runner, Session, ThreadRows } from "@hercule/contract";
import { findModelName } from "./model-name";
import { decideThreadRowEnd, type ThreadRowEnd } from "./pose";
import { isSettled, WORKING_STATUSES } from "./status";

/** A row's state marker: working, waiting for input, or over. */
export type ThreadMark = "working" | "idle" | "exited";

export interface ThreadRow {
  readonly id: string;
  readonly mark: ThreadMark;
  readonly title: string;
  readonly activityAt: string;
  readonly secondLine: string | null;
  /**
   * What the end of the row shows. A row whose end is a word, "queued" or
   * "offline", shows that word in place of its age.
   */
  readonly end: ThreadRowEnd;
}

/**
 * Compares two entries, each a session's last activity and its session id,
 * so that sorting puts the most recently active first, and two entries
 * active at the same moment in session id order. Ties are common: ending many
 * sessions at once stamps one time on all of them. Every list of thread rows,
 * and Waiting on you, sorts with this, so two lists that show the same
 * sessions show them in the same order.
 */
export const compareNewestFirst = (
  a: { readonly activityAt: string; readonly id: string },
  b: { readonly activityAt: string; readonly id: string },
): number =>
  Date.parse(b.activityAt) - Date.parse(a.activityAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Returns the state marker for a session's row. */
export const decideThreadMark = (session: Session): ThreadMark => {
  if (WORKING_STATUSES.has(session.status)) return "working";
  // An exited session that can be resumed takes input like any idle thread,
  // so it is shown as idle. Only a session that cannot be resumed is over.
  if (isSettled(session)) return "exited";
  return "idle";
};

/**
 * Returns the row of one session, with `secondLine` under its title. The
 * session's runner, looked up in `runners`, decides whether the row ends in
 * "offline"; a runner missing from the list counts as connected.
 */
export const buildThreadRow = (
  session: Session,
  secondLine: string | null,
  runners: readonly Runner[],
): ThreadRow => ({
  id: session.id,
  mark: decideThreadMark(session),
  title: session.title,
  activityAt: session.lastActivityAt,
  secondLine,
  end: decideThreadRowEnd(
    session,
    runners.find((runner) => runner.id === session.runnerId),
  ),
});

/**
 * Returns a row for each session, sorted by `compareNewestFirst`: the most
 * recently active first, and sessions active at the same moment by id. In
 * `meta` mode the second line is the model's name from `instances`; in `plain`
 * mode there is none.
 */
export const buildThreadRows = (
  sessions: readonly Session[],
  mode: ThreadRows,
  runners: readonly Runner[],
  instances: readonly ProviderInstance[] = [],
): readonly ThreadRow[] =>
  sessions
    .map((session) =>
      buildThreadRow(
        session,
        mode === "meta"
          ? findModelName(
              instances.find((each) => each.id === session.instanceId),
              session.modelSelection.model,
            )
          : null,
        runners,
      ),
    )
    .sort(compareNewestFirst);
