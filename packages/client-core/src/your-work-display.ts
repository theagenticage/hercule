/**
 * Describes Your work for the places that draw it: the signal pane's block,
 * the face on a signal's row, and a Now row's line (spec 17 §Intake rows, §The
 * pane). `matchYourWork` finds the Tasks; this file decides what they say.
 */
import {
  decideTrackingRowPose,
  isTrackingStateWaitingOnUser,
  nameTrackingState,
  readTrackingFaceSeed,
  type TrackingRow,
} from "./tracking";
import type { Pose } from "./threads/pose";
import type { YourWorkTask } from "./your-work";

/** A Task of Your work that is a row of Tracking. */
interface TrackedWork {
  readonly kind: "tracked";
  readonly taskId: string;
  readonly title: string;
  /** The text the face of the agent on the Task is drawn from (see `readTrackingFaceSeed`). */
  readonly faceSeed: string;
  /** The pose of the face (see `decideTrackingRowPose`). */
  readonly pose: Pose;
  /** The state's word in lower case, such as "needs you". */
  readonly stateWord: string;
  /** Whether the row waits on the user, so the pane draws its state word in bold. */
  readonly waitsOnYou: boolean;
}

/** A Task of Your work that no row of Tracking follows, because nothing was handed off to an agent on it. */
interface UntrackedWork {
  readonly kind: "untracked";
  readonly taskId: string;
  readonly title: string;
  /** The Task's status as a word: "Open" or "In progress". */
  readonly statusWord: string;
}

/** One Task of a signal's Your work, as the pane draws it. */
export type YourWorkItem = TrackedWork | UntrackedWork;

/** Returns the word for the status of an open Task. */
const nameOpenStatus = (status: YourWorkTask["status"]): string =>
  status === "in-progress" ? "In progress" : "Open";

/**
 * Describes each of `tasks`, a signal's Your work, in the order given. A Task
 * with a row in `rows` is tracked: it carries its agent's face seed, its
 * face's pose and its row's state. Any other Task is untracked and carries its status.
 */
export const describeYourWork = (
  tasks: ReadonlyArray<YourWorkTask>,
  rows: ReadonlyArray<TrackingRow>,
): ReadonlyArray<YourWorkItem> =>
  tasks.map((task): YourWorkItem => {
    const row = rows.find((each) => each.task.taskId === task.id);
    if (row === undefined) {
      return {
        kind: "untracked",
        taskId: task.id,
        title: task.title,
        statusWord: nameOpenStatus(task.status),
      };
    }
    return {
      kind: "tracked",
      taskId: task.id,
      title: task.title,
      faceSeed: readTrackingFaceSeed(row),
      pose: decideTrackingRowPose(row),
      stateWord: nameTrackingState(row.state).toLowerCase(),
      waitsOnYou: isTrackingStateWaitingOnUser(row.state),
    };
  });

/** What a signal's row draws of its Your work. */
interface YourWorkOnRow {
  /**
   * The text the face that leads the row is drawn from: the agent on the
   * first tracked Task of Your work. `null` when no Task is tracked, and the
   * row is led by its source's mark.
   */
  readonly faceSeed: string | null;
  /** The title of the first Task of Your work, which a Now row leads its second line with. `null` when the signal has no Your work. */
  readonly firstTaskTitle: string | null;
}

/**
 * Describes what a signal's row draws of its Your work `tasks`: the face of
 * the first tracked Task, and the title of the first Task. `rows` are
 * Tracking's rows.
 */
export const describeYourWorkOnRow = (
  tasks: ReadonlyArray<YourWorkTask>,
  rows: ReadonlyArray<TrackingRow>,
): YourWorkOnRow => {
  const items = describeYourWork(tasks, rows);
  const tracked = items.find((item): item is TrackedWork => item.kind === "tracked");
  return { faceSeed: tracked?.faceSeed ?? null, firstTaskTitle: items[0]?.title ?? null };
};
