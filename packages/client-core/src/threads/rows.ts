/**
 * How a session is shown as a row in the sidebar and on All sessions.
 * `activityAt` stays a raw timestamp: formatting "how long ago" needs a clock,
 * and only the caller should read one.
 */
import type { ProviderInstance, Session, ThreadRows } from "@hercule/contract";
import { findModelName } from "./model-name";
import { isSettled, WORKING_STATUSES } from "./status";

/** A row's state marker: working, waiting for input, or over. */
export type ThreadMark = "working" | "idle" | "exited";

export interface ThreadRow {
  readonly id: string;
  readonly mark: ThreadMark;
  readonly title: string;
  readonly activityAt: string;
  readonly secondLine: string | null;
}

/**
 * Compares two rows so that sorting puts the most recently active first, and
 * two rows active at the same moment in session id order. Ties are common:
 * ending many sessions at once stamps one time on all of them. Every list of
 * thread rows sorts with this, so two lists that show the same threads show
 * them in the same order.
 */
export const compareNewestFirst = (a: ThreadRow, b: ThreadRow): number =>
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
 * Returns a row for each session, sorted by `compareNewestFirst`: the most
 * recently active first, and sessions active at the same moment by id.
 */
export const buildThreadRows = (
  sessions: readonly Session[],
  mode: ThreadRows,
  /** The instances whose catalogs give a `meta` row its model name. A plain row shows no model. */
  instances: readonly ProviderInstance[] = [],
): readonly ThreadRow[] =>
  sessions
    .map((session) => ({
      id: session.id,
      mark: decideThreadMark(session),
      title: session.title,
      activityAt: session.lastActivityAt,
      secondLine:
        mode === "meta"
          ? findModelName(
              instances.find((each) => each.id === session.instanceId),
              session.modelSelection.model,
            )
          : null,
    }))
    .sort(compareNewestFirst);
