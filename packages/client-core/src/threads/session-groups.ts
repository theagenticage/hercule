/**
 * Groups the sessions the desktop sidebar holds into rows: the Threads and
 * Agent sessions that work in one workspace are one row (spec 17 §The sidebar).
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

/** Compares two strings by code unit, returning a negative, zero or positive number as `sort` expects. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compares two sessions so that sorting puts the oldest first, and sessions created at the same moment in id order. */
const compareOldestCreatedFirst = (a: Session, b: Session): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id);

/** Returns the latest of `times`, which must hold at least one timestamp. */
const pickLatestTime = (times: readonly string[]): string =>
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
    const group = members.get(key);
    if (group === undefined) members.set(key, [session]);
    else group.push(session);
  }

  const groups: SessionGroup[] = [];
  for (const [key, group] of members) {
    const ordered = group.toSorted(compareOldestCreatedFirst);
    const threads = ordered.filter((session) => session.kind === "thread");
    const lead = threads[0];
    if (lead === undefined) continue;
    // A partner's creation must not move the group, so only a partner that was reopened counts.
    const lastStartedAt = pickLatestTime(
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
      doneAt: allDone ? pickLatestTime(doneTimes) : null,
    });
  }
  return groups.toSorted(
    (a, b) =>
      Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt) || compareText(a.key, b.key),
  );
};

/**
 * Returns the name that tells `sessionId` apart from the other sessions of
 * `group`, or `null` when nothing needs telling apart: the lead, and any
 * session of a group with one session. `label` is what the session is called
 * in its group, as `labelWorkspaceSessions` returns it.
 *
 * The sidebar's second line and Waiting on you both name the session that
 * asks with this rule, so they agree.
 */
export const decideAskerLabel = (
  group: SessionGroup,
  sessionId: string,
  label: string,
): string | null => (group.sessions.length === 1 || sessionId === group.lead.id ? null : label);

/**
 * Returns the ids of the projects that hold work, in the order the desktop
 * sidebar lists them: by when the project's newest group started
 * (`SessionGroup.lastStartedAt`), newest first, and projects that tie by
 * project id. The result is a plain array of ids, so a caller that reads it
 * through React Query's `select` keeps the same array while nothing changed.
 *
 * It follows the sidebar's rule. A group belongs to its lead's project, and a
 * group on the Done shelf is in none. A partner's spawn never moves a
 * project, because it does not move its group. A project with no group in
 * its list is not in the result; the sidebar sorts those last, by project
 * id, and so should a caller that lists them.
 *
 * It ignores a Draft Thread on purpose. A draft is not a session until it
 * starts, and the sidebar moves the project that holds the draft being
 * written to the top. This order is for the lists of other screens, and they
 * should not reorder their project groups when the user opens or abandons a
 * draft.
 *
 * It does not know which projects exist. The sidebar files the groups of a
 * deleted project under "No project", so a caller drops ids it does not
 * list, as `groupByProject` does.
 */
export const orderProjectIdsByNewestGroup = (sessions: readonly Session[]): readonly string[] => {
  const newestByProject = new Map<string, number>();
  for (const group of buildSessionGroups(sessions)) {
    const projectId = group.lead.projectId;
    if (group.doneAt !== null || projectId === null) continue;
    const started = Date.parse(group.lastStartedAt);
    newestByProject.set(projectId, Math.max(newestByProject.get(projectId) ?? 0, started));
  }
  return [...newestByProject]
    .map(([projectId, newest]) => ({ projectId, newest }))
    .sort((a, b) => b.newest - a.newest || compareText(a.projectId, b.projectId))
    .map(({ projectId }) => projectId);
};
