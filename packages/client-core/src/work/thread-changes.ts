/**
 * Starting a Thread on a Task from its card, and moving a Thread to a Task of
 * its own: the request a start sends, and the words around both.
 */
import type { SessionSpawnInput, Workspace, WorkCard } from "@hercule/contract";
import { dropClosingFullStops } from "../text";
import { shortenTitle } from "./card-title";

/** The Task a Thread is started on: what the request needs of its card. */
export type StartTarget = Pick<WorkCard, "id" | "title" | "projectId">;

/** The newest session of the Task (of any kind) and where it worked, as far as the client read them. */
export interface NewestSessionPlace {
  /**
   * The id of the workspace the newest session of the Task worked in, or
   * `null` when that session had none, or the Task has no session yet.
   */
  readonly workspaceId: string | null;
  /** That workspace as read, or `null` when it could not be found. */
  readonly workspace: Pick<Workspace, "id" | "runnerId" | "status"> | null;
}

/** A request to start a Thread on a Task, and what to tell the user about how it was placed. */
export interface TaskThreadStart {
  readonly input: SessionSpawnInput;
  /**
   * A sentence for the undo line when the Thread could not start where the
   * Task's newest session worked, or `undefined` when nothing was left out.
   */
  readonly note: string | undefined;
}

/**
 * Returns the request that starts a Thread on a Task with `prompt`. It names
 * the Task and its Project, so the join rule puts the Thread on it, and it
 * places the Thread in the workspace of the Task's newest session (on that
 * workspace's runner) when `newest` says that workspace is ready.
 *
 * When the newest session worked in a workspace that is not ready (or cannot be
 * found), the request leaves the workspace out, and `note` says so: the
 * Thread then starts with no workspace, and the user hears of it.
 */
export const buildTaskThreadStart = (
  prompt: string,
  target: StartTarget,
  newest: NewestSessionPlace,
): TaskThreadStart => {
  const base: SessionSpawnInput = {
    prompt,
    taskId: target.id,
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
  };
  if (newest.workspaceId === null) return { input: base, note: undefined };
  const { workspace } = newest;
  if (workspace === null || workspace.status !== "ready") {
    return {
      input: base,
      note: "The workspace of its last thread is no longer available, so the new thread started without one.",
    };
  }
  return {
    input: {
      ...base,
      runnerId: workspace.runnerId,
      workspace: { kind: "existing", workspaceId: workspace.id },
    },
    note: undefined,
  };
};

/** Returns the words for the undo line after a Thread started on `card`. */
export const describeThreadStarted = (card: Pick<WorkCard, "title">): string =>
  `A thread started on "${shortenTitle(card.title)}".`;

/**
 * Returns the words for the undo line when the controller refused to start a
 * Thread on `card`. `reason` is the controller's message. The pane closed when
 * the prompt was sent, so the words also say that the prompt is back in the
 * pane's line.
 */
export const describeThreadRefused = (card: Pick<WorkCard, "title">, reason: string): string =>
  `Could not start a thread on "${shortenTitle(card.title)}": ${dropClosingFullStops(reason)}. Your words are back in the pane.`;

/**
 * Returns the sentence that goes where "Move to a new Task" is offered, before
 * the user chooses it: moving a Thread does not move the workspace's link to
 * its Task, so the next Thread started in that workspace joins the old Task
 * again.
 */
export const describeNextThreadJoin = (card: Pick<WorkCard, "title">): string =>
  `The next thread here still joins "${shortenTitle(card.title)}".`;

/** The words for the undo line after a Thread moved to a new Task. */
export const THREAD_MOVED_WORDS = "Moved the thread to a new Task.";
