/**
 * Reads the item details every adapter shares: an `unknown` item's label, a
 * `context_compaction` item's trigger, token counts and summary, and a
 * `todo_list` item's steps. These shapes are schemas in `@hercule/contract`;
 * this file is the one place a client decodes them, so the desktop's rows and
 * the web's rows can never read one item differently. It also reads the two
 * fields of a tool call's detail that every adapter spells the same way: the
 * tool's name with its MCP server, and the URL of a page fetch.
 *
 * A detail that does not decode, such as one written before the shape existed,
 * reads as having nothing in it. The row is then drawn from its kind alone.
 */
import { Option, Schema } from "effect";
import {
  ContextCompactionDetail,
  TodoListDetail,
  type TodoStep,
  UnknownItemDetail,
} from "@hercule/contract";
import { readJsonObject } from "../json-shape";
import { formatTokenCount } from "../subagents/describe";

const decodeCompactionDetail = Schema.decodeUnknownOption(ContextCompactionDetail);
const decodeUnknownItemDetail = Schema.decodeUnknownOption(UnknownItemDetail);
const decodeTodoListDetail = Schema.decodeUnknownOption(TodoListDetail);

/**
 * Returns the compaction detail `detail` holds, or `undefined` when it is
 * absent or does not decode. A decoded detail may have no fields at all.
 */
export const readCompactionDetail = (detail: unknown): ContextCompactionDetail | undefined =>
  Option.getOrUndefined(decodeCompactionDetail(detail));

/**
 * Returns the words after "Compacted the context" for a compaction item's
 * decoded `detail`, such as "182k → 31k tokens (auto)":
 *
 * - both counts known: "182k → 31k tokens";
 * - only the count before known: "from 182k tokens";
 * - only the count after known: "to 31k tokens";
 * - the trigger, "(auto)" or "(manual)", follows when it is known;
 * - "" when no count is known, whatever the trigger. A compaction with no
 *   numbers reads just "Compacted the context".
 *
 */
export const describeCompactionTarget = (detail: ContextCompactionDetail): string => {
  const { trigger, tokensBefore, tokensAfter } = detail;
  const before = tokensBefore === undefined ? undefined : formatTokenCount(tokensBefore);
  const after = tokensAfter === undefined ? undefined : formatTokenCount(tokensAfter);
  const size =
    before !== undefined && after !== undefined
      ? `${before} → ${after} tokens`
      : before !== undefined
        ? `from ${before} tokens`
        : after !== undefined
          ? `to ${after} tokens`
          : "";
  return size === "" || trigger === undefined ? size : `${size} (${trigger})`;
};

/**
 * Returns the label an `unknown` item's `detail` holds, such as
 * `claude: system/foo_bar`, or "" when it holds none. A row written before
 * the label existed holds none.
 */
export const readUnknownLabel = (detail: unknown): string =>
  Option.getOrUndefined(decodeUnknownItemDetail(detail))?.label ?? "";

/**
 * Returns the todo list `detail` holds, or `undefined` when it is absent or
 * does not decode. The runner leaves `detail` off an event that is too big
 * for one frame, so a caller must keep the list it already has when this
 * returns `undefined`, and never read that as an empty list.
 */
export const readTodoListDetail = (detail: unknown): TodoListDetail | undefined =>
  Option.getOrUndefined(decodeTodoListDetail(detail));

/** How far a todo list has come, as the rows of both clients show it. */
export interface TodoListSummary {
  /** How many steps are completed. */
  readonly completed: number;
  /** How many steps the list has. */
  readonly total: number;
  /** The progress as one count, such as "2/5". */
  readonly progress: string;
  /**
   * The text of the first step that is in progress, or "" when no step is.
   * A list can have several steps in progress; one is enough to say what
   * the agent is doing.
   */
  readonly current: string;
}

/** Returns how far a todo list's `steps` have come (`TodoListSummary`). */
export const summarizeTodoList = (steps: readonly TodoStep[]): TodoListSummary => {
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    completed,
    total: steps.length,
    progress: `${completed}/${steps.length}`,
    current: steps.find((step) => step.status === "in_progress")?.text ?? "",
  };
};

/**
 * Returns the name a tool call's `detail` holds, as the rows show it: the
 * tool's `name`, and for a call an MCP server made through Anthropic's API
 * connector, the server's name before it, such as `github/create_issue`. In
 * that case the adapter writes the bare tool name and the server apart.
 * Returns "" when the detail names no tool.
 */
export const readToolCallName = (detail: unknown): string => {
  const object = readJsonObject(detail);
  const name = object?.name;
  if (typeof name !== "string") return "";
  const server = object?.server;
  return typeof server === "string" && server !== "" ? `${server}/${name}` : name;
};

/**
 * Returns the URL a `web_search` item's `detail` fetched, or "" when the item
 * searched instead of fetching. The adapter writes `url` for a page fetch and
 * `query` for a search, whatever the harness calls its tools, so this is how
 * a client tells the two apart.
 */
export const readFetchedUrl = (detail: unknown): string => {
  const url = readJsonObject(detail)?.url;
  return typeof url === "string" ? url : "";
};
