/**
 * What the details pane says and shows about the Tasks a Task waits on and the
 * Tasks that wait on it: the rows of Blocked by and Blocks, the Tasks "Add a
 * blocker" offers, and the words of each change on the undo line.
 */
import {
  isFinishedStage,
  type TaskDetail,
  type TaskStage,
  type WorkCard,
  type WorkCardBlocker,
} from "@hercule/contract";
import { nameTaskStage } from "./add-list";
import { shortenTitle } from "./card-title";
import { findCards } from "./find";

/** One Task in Blocked by or in Blocks. */
export interface BlockerRow {
  readonly id: string;
  readonly title: string;
  /** The stage the row says the Task is at: a board stage's name, "Done" or "Dropped". */
  readonly stageName: string;
  /**
   * True when the Task is at a board stage, so its row opens it in the pane.
   * A Task that is Done or Dropped has no card and its details cannot be read,
   * so its row is plain history.
   */
  readonly canOpen: boolean;
  /**
   * True for a Blocked by row whose Task no longer holds this one back,
   * because it landed or finished. The row stays so the user can see the
   * history and remove it, and reads quietly.
   */
  readonly isQuiet: boolean;
}

/** The rows of one section, and the words for the Tasks the section cuts off. */
export interface BlockerList {
  readonly rows: readonly BlockerRow[];
  /** "and 12 more" when the Task has more than the rows listed, else `null`. */
  readonly moreWords: string | null;
}

/** The two sections of the pane. A list with no row is not drawn. */
export interface TaskBlockerSections {
  readonly blockedBy: BlockerList;
  readonly blocks: BlockerList;
}

/** What the sections are built from: the Task's details, which cut each list at a fixed length. */
export type TaskBlockers = Pick<TaskDetail, "blockers" | "blockerCount" | "blocks" | "blockCount">;

/** Returns true when a Task at `stage` still holds back the Tasks that wait on it. */
const holdsBack = (stage: TaskStage): boolean => stage !== "landed" && !isFinishedStage(stage);

const buildList = (
  tasks: readonly WorkCardBlocker[],
  total: number,
  isQuiet: (stage: TaskStage) => boolean,
): BlockerList => {
  const hidden = total - tasks.length;
  return {
    rows: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      stageName: nameTaskStage(task.stage),
      canOpen: !isFinishedStage(task.stage),
      isQuiet: isQuiet(task.stage),
    })),
    moreWords: hidden > 0 ? `and ${String(hidden)} more` : null,
  };
};

/**
 * Builds the rows of Blocked by and Blocks from the Task's details, in the
 * order the controller lists them (the order the blockers were added).
 *
 * - A Blocked by row is quiet when its Task landed, finished or was dropped.
 * - A Task past the controller's cut is not listed: `moreWords` says how many
 *   ("and 12 more"), from the totals.
 */
export const buildTaskBlockerSections = (blockers: TaskBlockers): TaskBlockerSections => ({
  blockedBy: buildList(blockers.blockers, blockers.blockerCount, (stage) => !holdsBack(stage)),
  blocks: buildList(blockers.blocks, blockers.blockCount, () => false),
});

/** The Task whose blockers are being chosen, and the Tasks it waits on already. */
export interface BlockerSearchScope {
  readonly taskId: string;
  /** The ids of the Tasks that block it already, which the search does not offer again. */
  readonly blockedByIds: readonly string[];
}

/**
 * Returns the cards "Add a blocker" offers for the words `text`: the top
 * matches of Find over `cards`, without the Task itself and without the Tasks
 * it waits on already. Returns none for empty words.
 *
 * A card that waits on this Task is offered too: the controller refuses that
 * one with the path of the loop, which is more useful than hiding it.
 */
export const listBlockerCandidates = (
  cards: readonly WorkCard[],
  text: string,
  scope: BlockerSearchScope,
): readonly WorkCard[] =>
  findCards(
    cards.filter((card) => card.id !== scope.taskId && !scope.blockedByIds.includes(card.id)),
    text,
  ).topMatches;

/** Which way a blocker changes: it is added to the Task, or taken away. */
export type BlockerDirection = "add" | "remove";

/** Returns the direction that undoes `direction`. */
export const reverseBlockerDirection = (direction: BlockerDirection): BlockerDirection =>
  direction === "add" ? "remove" : "add";

/** The titles a sentence about a blocker names, cut to fit the undo line. */
interface BlockerTitles {
  readonly task: string;
  readonly blocker: string;
}

const nameTitles = (taskTitle: string, blockerTitle: string): BlockerTitles => ({
  task: shortenTitle(taskTitle),
  blocker: shortenTitle(blockerTitle),
});

/**
 * Returns the words of the gesture, in the past tense, as the undo line shows
 * them and Undo reports them ("Put back: Made Pack the crates wait on ...").
 */
export const describeBlockerGesture = (
  direction: BlockerDirection,
  taskTitle: string,
  blockerTitle: string,
): string => {
  const { task, blocker } = nameTitles(taskTitle, blockerTitle);
  return direction === "add"
    ? `Made ${task} wait on ${blocker}`
    : `Took ${blocker} off what ${task} waits on`;
};

/** Returns the sentence for a change the user asked for, which the undo line says when they act. */
export const describeBlockerDone = (
  direction: BlockerDirection,
  taskTitle: string,
  blockerTitle: string,
): string => {
  const { task, blocker } = nameTitles(taskTitle, blockerTitle);
  return direction === "add"
    ? `${task} now waits on ${blocker}.`
    : `${task} no longer waits on ${blocker}.`;
};

/**
 * Returns the sentence for a change that found nothing to do: the Task waited
 * on the other one already, or did not wait on it. It replaces the sentence
 * said when the user acted, which was for a change that has not happened.
 */
export const describeBlockerNothing = (
  direction: BlockerDirection,
  taskTitle: string,
  blockerTitle: string,
): string => {
  const { task, blocker } = nameTitles(taskTitle, blockerTitle);
  return direction === "add"
    ? `${task} waited on ${blocker} already, so nothing changed.`
    : `${task} did not wait on ${blocker}, so nothing was removed.`;
};

/** Returns the sentence for a change the controller refused, with its `reason` and what to do. */
export const describeBlockerFailure = (
  direction: BlockerDirection,
  taskTitle: string,
  blockerTitle: string,
  reason: string,
): string => {
  const { task, blocker } = nameTitles(taskTitle, blockerTitle);
  return direction === "add"
    ? `${task} was not made to wait on ${blocker}: ${reason}. Try again.`
    : `${blocker} was not taken off what ${task} waits on: ${reason}. Try again.`;
};

/**
 * Returns the sentence for a blocker the controller refused because it would
 * make Tasks wait on each other in a loop. The pane shows the controller's own
 * message, which names the path, under the section, so this line does not
 * repeat it.
 */
export const describeBlockerLoopRefused = (taskTitle: string, blockerTitle: string): string => {
  const { task, blocker } = nameTitles(taskTitle, blockerTitle);
  return `${task} was not made to wait on ${blocker}.`;
};
