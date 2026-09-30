/**
 * Builds the start cards under a Draft Thread's composer: the open tasks of
 * the draft's project, most urgent first, each one a click away from a first
 * message that points the thread's agent at it.
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
  /** What a click adds to the Message Draft, see `buildStartMessage`. */
  readonly message: string;
}

/** A GitHub issue or pull request ref, `github:issue:owner/repo#42`: its kind, repository and number. */
const GITHUB_TICKET_REF = /^github:(issue|pr):([^\s#/]+\/[^\s#/]+)#(\d+)$/;

/**
 * Builds the one line a click on a task's card adds to the Message Draft:
 *
 * - "Pick up ticket <url>" when `ref` is a GitHub issue;
 * - "Pick up pull request <url>" when `ref` is a GitHub pull request;
 * - "Start working on task <id>: <title>" otherwise.
 *
 * The line points the thread's agent at the task rather than copying the
 * task's text: the agent reads the rest itself, with `gh` or with
 * `hercule task read`. So the message stays short, and text written outside
 * Hercule, such as an issue's body, never goes out as the user's own words.
 */
const buildStartMessage = (task: Task, ref: string | undefined): string => {
  const ticket = ref === undefined ? null : GITHUB_TICKET_REF.exec(ref);
  if (ticket === null) return `Start working on task ${task.id}: ${task.title}`;
  const [, kind, repo, number] = ticket;
  return kind === "issue"
    ? `Pick up ticket https://github.com/${repo}/issues/${number}`
    : `Pick up pull request https://github.com/${repo}/pull/${number}`;
};

/** Returns one start card per task, in the order the tasks are given. */
export const buildStartCards = (tasks: readonly Task[]): readonly StartCard[] =>
  tasks.map((task) => {
    // An external ref reads `<system>:<kind>:<identity>`. The card's mark and
    // its message both follow the first one, so the two always agree.
    const ref = task.provenance.find((entry) => entry.ref !== undefined)?.ref;
    return {
      taskId: task.id,
      kind: task.labels.includes(PROPOSED_LABEL) ? "Proposal" : "Task",
      priority: task.priority,
      bars: PRIORITY_BARS[task.priority],
      source: ref?.startsWith("github:") === true ? "github" : null,
      title: task.title,
      message: buildStartMessage(task, ref),
    };
  });

/**
 * Returns the Message Draft `draft` with `text` added: `text` alone when the
 * draft is empty or only whitespace, and otherwise after a blank line, so
 * what the user already wrote stays first and stays apart.
 */
export const appendToMessage = (draft: string, text: string): string =>
  draft.trim() === "" ? text : `${draft.trimEnd()}\n\n${text}`;
