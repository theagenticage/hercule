/**
 * The rows of an expanded work stretch in the desktop thread: one row per
 * step, with an icon, a label and a target, such as "Read /tmp/shot.png".
 * Consecutive steps of one kind fold into one row, such as "Read 3 files",
 * which expands to its steps.
 *
 * The web app keeps spec 14's rows (`ThreadItem.verb`); these rows are the
 * desktop's own (spec 17 §The thread).
 */
import { readJsonObject } from "../json-shape";
import type { WorkItem } from "./blocks";
import { countDistinctFiles, formatCount } from "./work-summary";

/**
 * The icon a row is drawn with, by name. The desktop maps each name to an
 * icon of its own, so no drawing code lives here.
 */
export type WorkRowIcon =
  | "eye"
  | "search"
  | "terminal"
  | "file"
  | "globe"
  | "puzzle"
  | "crew"
  | "list"
  | "sparkle"
  | "close"
  | "more";

/** One row of an expanded work stretch: a single step, or consecutive steps folded together. */
export interface WorkRow {
  /**
   * Unique in the transcript. A row of the stretch is `row:<itemId>` of its
   * first step, whether it holds one step or a group, so a row the reader
   * opened stays open when a second step folds onto it, and then shows its
   * steps. A step inside a group is `step:<itemId>`.
   */
  readonly key: string;
  readonly icon: WorkRowIcon;
  /** The row's words before its target: "Read", "Ran", a tool's name, or "Read 3 files" for a group. */
  readonly label: string;
  /** What the step acted on: a path, a command, a query. Empty for a group, and when the step names none. */
  readonly target: string;
  /** Whether the target is code, drawn in the mono face (`WorkItem.targetIsCode`). */
  readonly targetIsCode: boolean;
  /** When the step started, or a group's first step. */
  readonly startedAt: string;
  /**
   * The step's result. A group takes the first of `awaiting approval`,
   * `running`, `failed` and `declined` that one of its steps has, else
   * `completed`.
   */
  readonly result: WorkItem["result"];
  /**
   * The text the step returned (`readResultText`). Empty for a group, and
   * while the step runs or when it returned no text.
   */
  readonly output: string;
  /** A group's steps, in order. Empty for a single step. */
  readonly steps: readonly WorkRow[];
  /** Whether the row has something to open: it is a group, or a step whose output is not empty. */
  readonly canOpen: boolean;
}

type ItemKind = WorkItem["kind"];

/**
 * How a kind of step is drawn: its icon, its verb, and, for a kind whose
 * consecutive steps fold together, the label of the group they fold into.
 */
interface StepWords {
  readonly icon: WorkRowIcon;
  readonly verb: string;
  readonly describeGroup?: (steps: readonly WorkItem[]) => string;
}

const UNKNOWN_STEP: StepWords = { icon: "more", verb: "Step" };

const STEP_WORDS: Record<ItemKind, StepWords> = {
  reasoning: { icon: "sparkle", verb: "Thought" },
  command_execution: {
    icon: "terminal",
    verb: "Ran",
    describeGroup: (steps) => `Ran ${formatCount(steps.length, "command")}`,
  },
  file_change: {
    icon: "file",
    verb: "Edited",
    describeGroup: (steps) => `Edited ${formatCount(countDistinctFiles(steps), "file")}`,
  },
  file_read: {
    icon: "eye",
    verb: "Read",
    describeGroup: (steps) => `Read ${formatCount(countDistinctFiles(steps), "file")}`,
  },
  file_search: {
    icon: "search",
    verb: "Searched",
    describeGroup: (steps) => `Searched ${formatCount(steps.length, "time")}`,
  },
  web_search: {
    icon: "globe",
    verb: "Searched the web",
    describeGroup: (steps) => `Searched the web ${formatCount(steps.length, "time")}`,
  },
  tool_call: {
    icon: "puzzle",
    // The label of a single call is its tool's name, set in `buildStepRow`.
    verb: "Used a tool",
    describeGroup: (steps) =>
      `Used ${steps[0]!.toolName || "a tool"} ${formatCount(steps.length, "time")}`,
  },
  subagent: { icon: "crew", verb: "Subagent" },
  plan: { icon: "list", verb: "Planned" },
  context_compaction: { icon: "more", verb: "Compacted the context" },
  error: { icon: "close", verb: "Error" },
  unknown: UNKNOWN_STEP,
  // Messages never sit in a work stretch.
  user_message: UNKNOWN_STEP,
  assistant_message: UNKNOWN_STEP,
};

/** The results a group can take from its steps, in the order the first one present wins. */
const GROUP_RESULTS = ["awaiting approval", "running", "failed", "declined"] as const;

/**
 * The longest result text a row shows. A result is there to glance at, and
 * the whole of a long one would make the open row a page of its own.
 */
const MAX_RESULT_TEXT_LENGTH = 4096;

/**
 * Returns `text` cut to `length` characters. When the text ends in the first
 * half of a surrogate pair, that half is dropped, so the text never ends in a
 * broken character. A cut here leaves one when it splits a character in two,
 * and so does the adapter's cut of a string result, which reaches this
 * function already short enough.
 */
const cutResultText = (text: string, length: number): string => {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * Returns the text of a step's result (`WorkItem.resultContent`), cut to
 * `MAX_RESULT_TEXT_LENGTH` characters by `cutResultText`:
 *
 * - a string is used as it is;
 * - a list of content blocks (Claude Code's tool result) gives the `text` of
 *   its `{ type: "text" }` blocks, joined by line breaks. Any other block,
 *   such as an image, is skipped. Each block is cut to the room left before
 *   it is joined, so a long result never builds a long string;
 * - anything else, or no content, gives "".
 */
const readResultText = (content: unknown): string => {
  if (typeof content === "string") return cutResultText(content, MAX_RESULT_TEXT_LENGTH);
  if (!Array.isArray(content)) return "";
  let text = "";
  let blockCount = 0;
  for (const block of content as readonly unknown[]) {
    const object = readJsonObject(block);
    if (object?.type !== "text" || typeof object.text !== "string") continue;
    const separator = blockCount === 0 ? "" : "\n";
    const room = MAX_RESULT_TEXT_LENGTH - text.length - separator.length;
    if (room < 0) break;
    text += separator + object.text.slice(0, room);
    blockCount += 1;
  }
  return cutResultText(text, MAX_RESULT_TEXT_LENGTH);
};

/**
 * Checks whether `next` folds into the run of steps that starts with `first`:
 * both are of one kind that folds, and two tool calls also share their tool.
 * Only tool calls compare names: a file change's tool may be `Edit` or
 * `Write`, and both are edits.
 */
const foldsWith = (first: WorkItem, next: WorkItem): boolean =>
  first.kind === next.kind &&
  STEP_WORDS[first.kind].describeGroup !== undefined &&
  (first.kind !== "tool_call" || first.toolName === next.toolName);

/**
 * Returns the row of a single step, under `key`. A tool call's label is its
 * tool's name. Reasoning names no target: its detail is the thought itself.
 */
const buildStepRow = (item: WorkItem, key: string): WorkRow => {
  const words = STEP_WORDS[item.kind];
  const output = readResultText(item.resultContent);
  return {
    key,
    icon: words.icon,
    label: item.kind === "tool_call" && item.toolName !== "" ? item.toolName : words.verb,
    target: item.kind === "reasoning" ? "" : item.target,
    targetIsCode: item.targetIsCode,
    startedAt: item.startedAt,
    result: item.result,
    output,
    steps: [],
    canOpen: output !== "",
  };
};

/** Returns the row of a run of steps: a step row for a run of one, else a group row. */
const buildRunRow = (run: readonly WorkItem[]): WorkRow => {
  const first = run[0]!;
  const key = `row:${first.itemId}`;
  if (run.length === 1) return buildStepRow(first, key);
  const words = STEP_WORDS[first.kind];
  return {
    key,
    icon: words.icon,
    label: words.describeGroup!(run),
    target: "",
    targetIsCode: false,
    startedAt: first.startedAt,
    result:
      GROUP_RESULTS.find((result) => run.some((item) => item.result === result)) ?? "completed",
    output: "",
    steps: run.map((item) => buildStepRow(item, `step:${item.itemId}`)),
    canOpen: true,
  };
};

/**
 * Returns the rows of a stretch's items, in order. Consecutive items of a kind
 * that folds become one group row when there are two or more of them:
 * commands, file changes, file reads, file searches, web searches, and tool
 * calls of the same tool. Reasoning, subagents, plans, compactions, errors and
 * unknown steps never fold.
 *
 * Each step's result text is read here, so the desktop calls this only while
 * a stretch is open.
 */
export const buildWorkRows = (items: readonly WorkItem[]): readonly WorkRow[] => {
  const rows: WorkRow[] = [];
  let run: WorkItem[] = [];
  for (const item of items) {
    if (run.length > 0 && !foldsWith(run[0]!, item)) {
      rows.push(buildRunRow(run));
      run = [];
    }
    run.push(item);
  }
  if (run.length > 0) rows.push(buildRunRow(run));
  return rows;
};
