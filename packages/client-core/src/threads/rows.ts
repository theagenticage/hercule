/**
 * How a session is shown as a row in the sidebar and on All sessions.
 * `activityAt` stays a raw timestamp: formatting "how long ago" needs a clock,
 * and only the caller should read one.
 */
import type { ProviderInstance, Session, ThreadRows } from "@hercule/contract";
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
 * Returns the display name of the thread's model from the catalog, such as
 * `Claude Sonnet 5`, rather than the slug `claude-sonnet-5`. When no snapshot
 * offers the slug any more, returns the slug itself rather than a blank,
 * because the thread still runs on that model.
 */
const findModelName = (instances: readonly ProviderInstance[], session: Session): string => {
  const slug = session.modelSelection.model;
  const instance = instances.find((each) => each.id === session.instanceId);
  for (const snapshot of instance?.snapshots ?? []) {
    const model = snapshot.models.find((each) => each.slug === slug);
    if (model !== undefined) return model.name;
  }
  return slug;
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
      secondLine: mode === "meta" ? findModelName(instances, session) : null,
    }))
    .sort(compareNewestFirst);
