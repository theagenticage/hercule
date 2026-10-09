/**
 * The words on a work stretch's divider in the desktop thread: "Worked for
 * 2m 14s" and a summary such as "ran 2 commands", "edited 3 files". The
 * divider's expanded list shows each item's verb, target and result, which
 * the `WorkItem`s already hold.
 */
import type { WorkBlock, WorkItem } from "./blocks";
import { formatDuration } from "./duration";

type ItemKind = WorkItem["kind"];

/** Returns `count` followed by `noun`, with an "s" when the count is not one. */
const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The summary phrase for each item kind, given how many of that kind the
 * stretch holds. A kind that is missing here is not counted: reasoning is the
 * agent thinking rather than doing, and messages never sit in a stretch.
 */
const PHRASES: Partial<Record<ItemKind, (count: number) => string>> = {
  command_execution: (count) => `ran ${formatCount(count, "command")}`,
  file_change: (count) => `edited ${formatCount(count, "file")}`,
  web_search: (count) => (count === 1 ? "searched the web" : `searched the web ${count} times`),
  tool_call: (count) => `used ${formatCount(count, "tool")}`,
  subagent: (count) => `ran ${formatCount(count, "subagent")}`,
  plan: (count) => (count === 1 ? "made a plan" : `made ${count} plans`),
  context_compaction: (count) =>
    count === 1 ? "compacted the context" : `compacted the context ${count} times`,
  error: (count) => `hit ${formatCount(count, "error")}`,
  unknown: (count) => `did ${formatCount(count, "other step")}`,
};

/**
 * Returns the summary of a stretch's items: one phrase per item kind, such as
 * "ran 2 commands", in the order each kind first appears. Reasoning is left
 * out. File changes count distinct files: the paths their details name, plus
 * one per change that names none, so two edits to one file read "edited 1
 * file".
 */
export const summarizeWork = (items: readonly WorkItem[]): readonly string[] => {
  // A Map keeps its keys in insertion order, which is the order of first appearance.
  const counts = new Map<ItemKind, number>();
  const paths = new Set<string>();
  for (const item of items) {
    if (PHRASES[item.kind] === undefined) continue;
    let added = 1;
    if (item.kind === "file_change" && item.paths.length > 0) {
      const before = paths.size;
      for (const path of item.paths) paths.add(path);
      added = paths.size - before;
    }
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + added);
  }
  return [...counts].map(([kind, count]) => PHRASES[kind]!(count));
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
