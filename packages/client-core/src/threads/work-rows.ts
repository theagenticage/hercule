/**
 * The rows of an expanded work stretch in the desktop thread: one row per
 * step, with an icon, a label and a target, such as "Read /tmp/shot.png".
 * Consecutive steps of one kind fold into one row, such as "Read 3 files",
 * which expands to its steps.
 *
 * The web app keeps spec 14's rows (`ThreadItem.verb`); these rows are the
 * desktop's own (spec 17 §The thread).
 */
import type { TodoStep, ToolResultImage } from "@hercule/contract";
import { readJsonObject } from "../json-shape";
import type { WorkItem } from "./blocks";
import { summarizeTodoList } from "./item-detail";
import { readToolResultImages } from "./tool-result-images";
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
  | "tasks"
  | "sparkle"
  | "close"
  | "question"
  | "compress"
  | "clock"
  | "palette"
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
  /**
   * Whether the output is code, drawn in the mono face and kept in whole
   * lines, as a command's output is. False for a compaction's summary and a
   * plan's text, which are prose, and for a group, which has no output of its
   * own.
   */
  readonly outputIsCode: boolean;
  /**
   * The images the step returned (`readToolResultImages`), in order. Empty
   * for a group, and while the step runs or when it returned none.
   */
  readonly images: readonly ToolResultImage[];
  /** A group's steps, in order. Empty for a single step. */
  readonly steps: readonly WorkRow[];
  /**
   * The steps of a todo list row, in the agent's order. `null` for every
   * other row, which is how a row tells a todo list from any other; a list
   * with no steps is `[]`. A group's tool calls are `steps`, not these.
   */
  readonly todoSteps: readonly TodoStep[] | null;
  /**
   * Whether the row has something to open: it is a group, a todo list with
   * steps, or a step that returned text or images.
   */
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
  // A page fetch is a `web_search` item too; `chooseStepWords` picks `PAGE_FETCH_WORDS` for it.
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
  context_compaction: { icon: "compress", verb: "Compacted the context" },
  error: { icon: "close", verb: "Error" },
  unknown: UNKNOWN_STEP,
  // The label of a todo list carries its progress, set in `buildStepRow`. It never folds.
  todo_list: { icon: "tasks", verb: "Tasks" },
  // The label of a wait carries how long it waited, set in `buildStepRow`.
  wait: { icon: "clock", verb: "Waited" },
  image_generation: { icon: "palette", verb: "Generated an image" },
  // Messages never sit in a work stretch.
  user_message: UNKNOWN_STEP,
  assistant_message: UNKNOWN_STEP,
};

/** How a page fetch is drawn. It is a `web_search` item with a URL, and it folds only with other fetches. */
const PAGE_FETCH_WORDS: StepWords = {
  icon: "globe",
  verb: "Fetched",
  describeGroup: (steps) => `Fetched ${formatCount(steps.length, "page")}`,
};

/** Returns the words that draw `item`: its kind's, or a page fetch's. */
const chooseStepWords = (item: WorkItem): StepWords =>
  item.isPageFetch ? PAGE_FETCH_WORDS : STEP_WORDS[item.kind];

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
 *   its `{ type: "text" }` blocks that are not empty, joined by line breaks.
 *   Any other block, such as an image, is skipped. Each block is cut to the
 *   room left before it is joined, and no block is read once the text is
 *   full, so a long result never builds a long string;
 * - anything else, or no content, gives "".
 */
const readResultText = (content: unknown): string => {
  if (typeof content === "string") return cutResultText(content, MAX_RESULT_TEXT_LENGTH);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content as readonly unknown[]) {
    if (text.length >= MAX_RESULT_TEXT_LENGTH) break;
    const object = readJsonObject(block);
    if (object?.type !== "text" || typeof object.text !== "string" || object.text === "") continue;
    const separator = text === "" ? "" : "\n";
    text +=
      separator + object.text.slice(0, MAX_RESULT_TEXT_LENGTH - text.length - separator.length);
  }
  return cutResultText(text, MAX_RESULT_TEXT_LENGTH);
};

/**
 * Checks whether `next` folds into the run of steps that starts with `first`:
 * both are of one kind that folds, and two tool calls also share their tool.
 * Only tool calls compare names: a file change's tool may be `Edit` or
 * `Write`, and both are edits. A tool call's name holds its MCP server
 * (`WorkItem.toolName`), so two calls fold only when the tool and the server
 * both match. A search and a page fetch are both `web_search` items and do
 * not fold together.
 */
const foldsWith = (first: WorkItem, next: WorkItem): boolean =>
  first.kind === next.kind &&
  first.isPageFetch === next.isPageFetch &&
  chooseStepWords(first).describeGroup !== undefined &&
  (first.kind !== "tool_call" || first.toolName === next.toolName);

/**
 * Returns the row of a single step, under `key`:
 *
 * - a tool call's label is its tool's name;
 * - a todo list's label is "Tasks" and its progress, such as "Tasks 2/5", its
 *   target the step in progress, and its steps are the row's `todoSteps`;
 * - an `unknown` step that has a label is drawn with the question icon, the
 *   label as its words and no target, so a message nobody mapped is named
 *   rather than shown as "Step";
 * - a wait's label carries how long it waited, such as "Waited 30s", and it
 *   names no target;
 * - reasoning names no target: its detail is the thought itself.
 */
const buildStepRow = (item: WorkItem, key: string): WorkRow => {
  const words = chooseStepWords(item);
  const output = readResultText(item.resultContent);
  const images = readToolResultImages(item.resultContent);
  const isLabelled = item.kind === "unknown" && item.fallbackLabel !== "";
  return {
    key,
    icon: isLabelled ? "question" : words.icon,
    label: isLabelled
      ? item.fallbackLabel
      : item.kind === "tool_call" && item.toolName !== ""
        ? item.toolName
        : item.kind === "todo_list"
          ? `${words.verb} ${summarizeTodoList(item.todoSteps).progress}`
          : item.kind === "wait" && item.target !== ""
            ? `${words.verb} ${item.target}`
            : words.verb,
    target: item.kind === "reasoning" || item.kind === "wait" || isLabelled ? "" : item.target,
    targetIsCode: item.targetIsCode,
    startedAt: item.startedAt,
    result: item.result,
    output,
    outputIsCode: item.kind !== "context_compaction" && item.kind !== "plan",
    images,
    steps: [],
    todoSteps: item.kind === "todo_list" ? item.todoSteps : null,
    canOpen: output !== "" || images.length > 0 || item.todoSteps.length > 0,
  };
};

/** Returns the row of a run of steps: a step row for a run of one, else a group row. */
const buildRunRow = (run: readonly WorkItem[]): WorkRow => {
  const first = run[0]!;
  const key = `row:${first.itemId}`;
  if (run.length === 1) return buildStepRow(first, key);
  const words = chooseStepWords(first);
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
    outputIsCode: false,
    images: [],
    steps: run.map((item) => buildStepRow(item, `step:${item.itemId}`)),
    todoSteps: null,
    canOpen: true,
  };
};

/**
 * Returns the rows of a stretch's items, in order. Consecutive items of a kind
 * that folds become one group row when there are two or more of them:
 * commands, file changes, file reads, file searches, web searches, page
 * fetches, and tool calls of the same tool and server. Reasoning, subagents,
 * plans, todo lists, waits, image generations, compactions, errors and unknown
 * steps never fold.
 *
 * Each step's result text and images are read here, so the desktop calls
 * this only while a stretch is open.
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
