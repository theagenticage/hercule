/**
 * The words on a work stretch's divider in the desktop thread: "Worked for
 * 2m 14s" and a summary such as "ran 2 commands", "edited 3 files". The
 * divider's expanded list is `buildWorkRows`.
 */
import type { WorkBlock, WorkItem } from "./blocks";
import { formatDuration } from "./duration";

type ItemKind = WorkItem["kind"];

/**
 * What the summary counts: an item kind, or `page_fetch` for a `web_search`
 * item that fetched a page, which reads differently from a search.
 */
type SummaryKey = ItemKind | "page_fetch";

/** Returns `count` followed by `noun`, with an "s" when the count is not one. */
export const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The summary phrase for each key, given how many items of that key the
 * stretch holds, or `null` for a key the summary does not count: reasoning is
 * the agent thinking rather than doing, a todo list is a note the agent keeps
 * (its row already shows its progress), and messages never sit in a stretch.
 * The record covers every key, so a new item kind fails the typecheck until
 * someone decides whether the summary counts it.
 */
const PHRASES: Record<SummaryKey, ((count: number) => string) | null> = {
  reasoning: null,
  todo_list: null,
  user_message: null,
  assistant_message: null,
  command_execution: (count) => `ran ${formatCount(count, "command")}`,
  file_change: (count) => `edited ${formatCount(count, "file")}`,
  file_read: (count) => `read ${formatCount(count, "file")}`,
  file_search: (count) => (count === 1 ? "searched once" : `searched ${count} times`),
  web_search: (count) => (count === 1 ? "searched the web" : `searched the web ${count} times`),
  page_fetch: (count) => `fetched ${formatCount(count, "page")}`,
  tool_call: (count) => `used ${formatCount(count, "tool")}`,
  subagent: (count) => `ran ${formatCount(count, "subagent")}`,
  plan: (count) => (count === 1 ? "made a plan" : `made ${count} plans`),
  wait: (count) => (count === 1 ? "waited once" : `waited ${count} times`),
  image_generation: (count) => `generated ${count === 1 ? "an image" : `${count} images`}`,
  context_compaction: (count) =>
    count === 1 ? "compacted the context" : `compacted the context ${count} times`,
  error: (count) => `hit ${formatCount(count, "error")}`,
  unknown: (count) => `did ${formatCount(count, "other step")}`,
};

/** The kinds whose summary counts distinct files rather than items (`countDistinctFiles`). */
const FILE_KINDS: ReadonlySet<SummaryKey> = new Set(["file_change", "file_read"]);

/**
 * Returns how many files `items` name: the distinct paths their details name,
 * plus one per item that names none. Two edits to one file count as one
 * file. The caller passes items of one kind, so edits and reads of one file
 * are not counted together.
 */
export const countDistinctFiles = (items: readonly WorkItem[]): number => {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const item of items) {
    if (item.paths.length === 0) unnamed += 1;
    for (const path of item.paths) paths.add(path);
  }
  return paths.size + unnamed;
};

/**
 * Returns the summary of a stretch's items: one phrase per item kind, such as
 * "ran 2 commands", in the order each kind first appears. Reasoning and todo
 * lists are left out (`PHRASES`). Page fetches count apart from web searches. File
 * changes and file reads count distinct files (`countDistinctFiles`), so two
 * edits to one file read "edited 1 file". An image generation counts only
 * when it completed, so the summary never claims an image that was not made.
 */
export const summarizeWork = (items: readonly WorkItem[]): readonly string[] => {
  // A Map keeps its keys in insertion order, which is the order of first appearance.
  const itemsByKind = new Map<SummaryKey, WorkItem[]>();
  for (const item of items) {
    const key: SummaryKey = item.isPageFetch ? "page_fetch" : item.kind;
    if (PHRASES[key] === null) continue;
    if (key === "image_generation" && item.result !== "completed") continue;
    const ofKind = itemsByKind.get(key);
    if (ofKind === undefined) itemsByKind.set(key, [item]);
    else ofKind.push(item);
  }
  return [...itemsByKind].map(([kind, ofKind]) =>
    PHRASES[kind]!(FILE_KINDS.has(kind) ? countDistinctFiles(ofKind) : ofKind.length),
  );
};

/**
 * Returns the words on a stretch's divider: "Working for 12s" while the
 * stretch runs, counted from its start to `now` (milliseconds since the
 * epoch), else "Worked for 2m 14s". A stretch that waits on an open Request
 * has stopped at the Request's opening, so it reads "Worked for".
 */
export const describeWorkStretch = (block: WorkBlock, now: number): string => {
  const startedAt = Date.parse(block.startedAt);
  return block.endedAt === null
    ? `Working for ${formatDuration(now - startedAt)}`
    : `Worked for ${formatDuration(Date.parse(block.endedAt) - startedAt)}`;
};

/**
 * Returns the words on a turn's status line while nothing else shows that
 * the agent is busy: "Working for 12s", counted from `since` to `now`
 * (milliseconds since the epoch), or "Starting…" when `since` is `null`
 * because no turn has started yet.
 */
export const describePending = (since: string | null, now: number): string =>
  since === null ? "Starting…" : `Working for ${formatDuration(now - Date.parse(since))}`;
