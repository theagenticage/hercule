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

/** Returns the key of the group of the sessions that work in the workspace `workspaceId`, as `SessionGroup.key` spells it. */
export const buildWorkspaceGroupKey = (workspaceId: string): string => `workspace:${workspaceId}`;

/** Returns the key of the group that holds `session`, as `SessionGroup.key` spells it. */
export const buildGroupKey = (session: Session): string =>
  session.workspaceId === null
    ? `session:${session.id}`
    : buildWorkspaceGroupKey(session.workspaceId);

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
 * `sessions` holds Threads and Agent sessions only, each once, as the
 * sidebar's read returns them.
 *
 * - Sessions group by their workspace id, not by `Workspace.sessionIds`,
 *   which no longer lists a session that has exited.
 * - A group needs a Thread. A Thread with no workspace is a group of its own;
 *   an Agent session with no workspace, or one whose workspace holds no
 *   Thread, is left out.
 *
 * An Agent session counts as ended when its status is `exited`, not when it
 * is settled (`isSettled`): a session that exited normally can still be
 * resumed, so it would never be settled, and its row would never reach the
 * Done shelf. An exited session is not working, which is all the shelf needs.
 */
export const buildSessionGroups = (sessions: readonly Session[]): readonly SessionGroup[] => {
  const members = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.workspaceId === null && session.kind === "agent") continue;
    const key = buildGroupKey(session);
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
 * Returns the distinct project ids of `groups`, in the order the desktop
 * sidebar and the project lists of other screens share: by when the
 * project's newest group started (`lastStartedAt`), newest first, and
 * projects that tie by project id. `null` stands for a group in no project.
 *
 * The sidebar adds its own rules on top of this order (the draft's project
 * first, no project last).
 */
export const orderGroupProjectIds = (
  groups: readonly { readonly projectId: string | null; readonly lastStartedAt: string }[],
): readonly (string | null)[] => {
  const newestByProject = new Map<string | null, number>();
  for (const { projectId, lastStartedAt } of groups) {
    newestByProject.set(
      projectId,
      Math.max(newestByProject.get(projectId) ?? 0, Date.parse(lastStartedAt)),
    );
  }
  return [...newestByProject.keys()].sort(
    (a, b) => newestByProject.get(b)! - newestByProject.get(a)! || compareText(a ?? "", b ?? ""),
  );
};

/**
 * Returns the ids of the projects that hold work, in the order the desktop
 * sidebar lists them (`orderGroupProjectIds`). The result is a plain array of
 * ids, so a caller that reads it through React Query's `select` keeps the same
 * array while nothing changed.
 *
 * A group belongs to its lead's project, and a group on the Done shelf is in
 * none. A partner's spawn never moves a project, because it does not move its
 * group. A project with no group in its list is not in the result; the
 * sidebar sorts those last, by project id, and so should a caller that lists
 * them.
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
export const orderProjectIdsByNewestGroup = (sessions: readonly Session[]): readonly string[] =>
  orderGroupProjectIds(
    buildSessionGroups(sessions)
      .filter((group) => group.doneAt === null)
      .map((group) => ({ projectId: group.lead.projectId, lastStartedAt: group.lastStartedAt })),
  ).filter((projectId): projectId is string => projectId !== null);
