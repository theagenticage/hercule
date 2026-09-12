/**
 * How a session reads as a row in the sidebar and on All sessions. The
 * `now`-free `activityAt` stays raw: formatting "how long ago" needs a clock,
 * and the caller's is the one that should ever run.
 */
import type { Session, ThreadRows } from "@hydra/contract";
import { isSettled, WORKING_STATUSES } from "./status";

export interface ThreadRow {
  readonly id: string;
  readonly mark: "working" | "idle" | "exited";
  readonly title: string;
  readonly activityAt: string;
  readonly secondLine: string | null;
}

const markOf = (session: Session): ThreadRow["mark"] => {
  if (WORKING_STATUSES.has(session.status)) return "working";
  // An exit that can be resumed takes input like any idle thread, so it reads
  // as one; only an exit that is refused reads as an ending.
  if (isSettled(session)) return "exited";
  return "idle";
};

export const threadRows = (sessions: readonly Session[], mode: ThreadRows): readonly ThreadRow[] =>
  [...sessions]
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .map((session) => ({
      id: session.id,
      mark: markOf(session),
      title: session.title,
      activityAt: session.lastActivityAt,
      secondLine: mode === "meta" ? session.modelSelection.model : null,
    }));
