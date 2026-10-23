/**
 * Groups the sessions the desktop sidebar holds into rows: the Threads and
 * Agent sessions that work in one workspace are one row (spec 14 §App shell).
 */
import type { Session } from "@hercule/contract";
import { pickLastStartedAt } from "./project-rows";

/** The sessions of one workspace that the desktop sidebar shows as one row. */
export interface SessionGroup {
  /** `workspace:<id>`, or `session:<id>` for a Thread with no workspace. Unique and stable across renders. */
  readonly key: string;
  /** The first Thread the list holds in the group: it names the row, and its project is the row's project. */
  readonly lead: Session;
  /** The group's Threads and Agent sessions (kind "thread" and "agent"), oldest created first, ties by id. The lead is among them. */
  readonly sessions: readonly Session[];
  /** When the group last started: the lead's creation, or the latest reopen of any of its Threads, whichever is later. A partner's creation never moves it. */
  readonly lastStartedAt: string;
  /** When the group was put on the Done shelf: the latest Done time of its Threads, once every Thread is marked Done and every Agent session has ended (status "exited"); otherwise `null`. */
  readonly doneAt: string | null;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareOldestCreatedFirst = (a: Session, b: Session): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id);

const latest = (times: readonly string[]): string =>
  times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/**
 * Returns the groups `sessions` form, newest `lastStartedAt` first and groups
 * that started at the same moment in key order, so the order never depends on
 * the order the server listed the sessions in.
 *
 * - Sessions group by their workspace id, not by `Workspace.sessionIds`,
 *   which no longer lists a session that has exited.
 * - Sessions of kind "run" and "assistant" belong to no group.
 * - A group needs a Thread. A Thread with no workspace is a group of its own;
 *   an Agent session with no workspace, or one whose workspace holds no
 *   Thread, is left out.
 * - When two reads of the same session were merged into `sessions`, the last
 *   one wins, because it is the newer read.
 *
 * An Agent session counts as ended when its status is `exited`, not when it
 * is settled (`isSettled`): a session that exited normally can still be
 * resumed, so it would never be settled, and its row would never reach the
 * Done shelf. An exited session is not working, which is all the shelf needs.
 */
export const buildSessionGroups = (sessions: readonly Session[]): readonly SessionGroup[] => {
  const latestReads = new Map<string, Session>();
  for (const session of sessions) latestReads.set(session.id, session);

  const members = new Map<string, Session[]>();
  for (const session of latestReads.values()) {
    if (session.kind !== "thread" && session.kind !== "agent") continue;
    if (session.workspaceId === null && session.kind === "agent") continue;
    const key =
      session.workspaceId === null ? `session:${session.id}` : `workspace:${session.workspaceId}`;
    members.set(key, [...(members.get(key) ?? []), session]);
  }

  const groups: SessionGroup[] = [];
  for (const [key, group] of members) {
    const ordered = group.toSorted(compareOldestCreatedFirst);
    const threads = ordered.filter((session) => session.kind === "thread");
    const lead = threads[0];
    if (lead === undefined) continue;
    // A partner's creation must not move the group, so only a partner that was reopened counts.
    const lastStartedAt = latest(
      threads
        .filter((thread) => thread === lead || thread.reopenedAt !== undefined)
        .map(pickLastStartedAt),
    );
    const doneTimes = threads.flatMap((thread) =>
      thread.done === undefined ? [] : [thread.done.at],
    );
    const allDone =
      doneTimes.length === threads.length &&
      ordered.every((session) => session.kind !== "agent" || session.status === "exited");
    groups.push({
      key,
      lead,
      sessions: ordered,
      lastStartedAt,
      doneAt: allDone ? latest(doneTimes) : null,
    });
  }
  return groups.toSorted(
    (a, b) =>
      Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt) || compareText(a.key, b.key),
  );
};
