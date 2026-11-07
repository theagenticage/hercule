/**
 * The words the details pane uses for one Thread of a Task: the name of its
 * row and the state it is in.
 */
import type { TaskDetailSession } from "@hercule/contract";
import { WORKING_STATUSES } from "../threads/status";

/** What a Thread row says about the Thread, in one word. */
export type TaskThreadState = "Asks" | "Waiting" | "Working" | "Done";

/** One Thread row of the details pane. */
export interface TaskThreadRow {
  readonly id: string;
  /** The Thread's role when it has one, else its title. */
  readonly label: string;
  /** The state to show beside the label, or `null` for a Thread at rest. */
  readonly state: TaskThreadState | null;
  /**
   * Whether the row offers "Move to a new Task". Only a Thread moves: the
   * controller refuses an Agent session and a run's session.
   */
  readonly canMoveToNewTask: boolean;
}

/**
 * Returns the name a Thread goes by in the pane: its role when that is not
 * blank, else its title. A workspace's list (`labelWorkspaceSessions`) uses
 * the same rule and also numbers repeated roles. The pane lists at most ten
 * Threads of one Task, so it shows the role as it is.
 */
export const chooseTaskThreadLabel = (
  session: Pick<TaskDetailSession, "role" | "title">,
): string => {
  const role = session.role?.trim() ?? "";
  return role === "" ? session.title : role;
};

/**
 * Returns the one word that says what a Thread is doing. The first rule that
 * matches decides:
 *
 * - an open question: "Asks";
 * - any other open Request, which is an approval: "Waiting";
 * - a running turn: "Working";
 * - marked Done by the user: "Done";
 * - otherwise `null`.
 *
 * A Thread marked Done can still be running, and then it reads "Working",
 * because the user cannot see that fact anywhere else in the pane.
 */
export const describeTaskThreadState = (session: TaskDetailSession): TaskThreadState | null => {
  if (session.openRequests.some((request) => request.kind === "question")) return "Asks";
  if (session.openRequests.length > 0) return "Waiting";
  if (WORKING_STATUSES.has(session.status)) return "Working";
  return session.done ? "Done" : null;
};

/** Returns the row of one Thread of the details pane. */
export const buildTaskThreadRow = (session: TaskDetailSession): TaskThreadRow => ({
  id: session.id,
  label: chooseTaskThreadLabel(session),
  state: describeTaskThreadState(session),
  canMoveToNewTask: session.kind === "thread",
});
