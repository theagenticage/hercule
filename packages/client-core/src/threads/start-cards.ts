/**
 * Builds the start cards under a Draft Thread's composer: the open tasks of
 * the draft's project, most urgent first, each one a click away from being
 * the thread's first message.
 */
import type { Task, TaskPriority } from "@hercule/contract";

/** The label that makes a task a Proposal (CONTEXT.md): prepared by agents, not yet accepted. */
const PROPOSED_LABEL = "proposed";

/** How many of four bars a priority fills. Four is urgent, which is drawn in the failure hue. */
const PRIORITY_BARS: Readonly<Record<TaskPriority, 1 | 2 | 3 | 4>> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export interface StartCard {
  readonly taskId: string;
  /** `Proposal` for a task the agents are asking the user to accept, `Task` otherwise. */
  readonly kind: "Proposal" | "Task";
  /** The task's priority, which the bars draw and which a screen reader reads out instead. */
  readonly priority: TaskPriority;
  readonly bars: 1 | 2 | 3 | 4;
  /**
   * The system the task came from, when the card can draw its mark: `github`
   * when the task's first external ref is a GitHub one, `null` otherwise.
   */
  readonly source: "github" | null;
  readonly title: string;
  /** What a click adds to the Message Draft: the title, and the description after a blank line. */
  readonly message: string;
}

/** Returns one start card per task, in the order the tasks are given. */
export const buildStartCards = (tasks: readonly Task[]): readonly StartCard[] =>
  tasks.map((task) => {
    const description = task.description.trim();
    // An external ref reads `<system>:<kind>:<identity>`.
    const ref = task.provenance.find((entry) => entry.ref !== undefined)?.ref;
    return {
      taskId: task.id,
      kind: task.labels.includes(PROPOSED_LABEL) ? "Proposal" : "Task",
      priority: task.priority,
      bars: PRIORITY_BARS[task.priority],
      source: ref?.startsWith("github:") === true ? "github" : null,
      title: task.title,
      message: description === "" ? task.title : `${task.title}\n\n${description}`,
    };
  });

/**
 * Returns the Message Draft `draft` with `text` added: `text` alone when the
 * draft is empty or only whitespace, and otherwise after a blank line, so
 * what the user already wrote stays first and stays apart.
 */
export const appendToMessage = (draft: string, text: string): string =>
  draft.trim() === "" ? text : `${draft.trimEnd()}\n\n${text}`;
