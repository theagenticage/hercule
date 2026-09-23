/**
 * How a session reads as a row in the sidebar and on All sessions. The
 * `now`-free `activityAt` stays raw: formatting "how long ago" needs a clock,
 * and the caller's is the one that should ever run.
 */
import type { ProviderInstance, Session, ThreadRows } from "@hercule/contract";
import { isSettled, WORKING_STATUSES } from "./status";

/** What a row's state mark says: working, waiting, or over. */
export type ThreadMark = "working" | "idle" | "exited";

export interface ThreadRow {
  readonly id: string;
  readonly mark: ThreadMark;
  readonly title: string;
  readonly activityAt: string;
  readonly secondLine: string | null;
}

export const decideThreadMark = (session: Session): ThreadMark => {
  if (WORKING_STATUSES.has(session.status)) return "working";
  // An exit that can be resumed takes input like any idle thread, so it reads
  // as one; only an exit that is refused reads as an ending.
  if (isSettled(session)) return "exited";
  return "idle";
};

/**
 * What the thread runs, as the catalog that offers it names it: `Claude Sonnet
 * 5`, never the `claude-sonnet-5` a request is written with, and never the bare
 * word `default` for the model a provider picks for itself. A slug no snapshot
 * offers any more is still what the thread runs under, so it is named as it
 * stands rather than going blank.
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

export const buildThreadRows = (
  sessions: readonly Session[],
  mode: ThreadRows,
  /** The catalogs a meta row's model is named from; a plain row names none. */
  instances: readonly ProviderInstance[] = [],
): readonly ThreadRow[] =>
  [...sessions]
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .map((session) => ({
      id: session.id,
      mark: decideThreadMark(session),
      title: session.title,
      activityAt: session.lastActivityAt,
      secondLine: mode === "meta" ? findModelName(instances, session) : null,
    }));
