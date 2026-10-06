/**
 * The words every screen shows for one subagent: the name of the agent that
 * started it, its state, the one line under its name and the facts about it.
 * They are read from the Subagent record alone, so a screen needs no
 * transcript to draw a subagent. The subagent's own name is `nameSubagent`,
 * in `./name`.
 */
import type { SessionRequest, Subagent, SubagentStatus } from "@hercule/contract";
import { formatDuration } from "../threads/duration";
import type { Pose } from "../threads/pose";
import { countUsedTokens } from "../token-usage";
import { nameSubagent } from "./name";
import { listSubagentDescendants } from "./tree";

/**
 * The colour a subagent's words are drawn in: `live` while it works, `attn`
 * while it waits on the user, `fail` once it failed, and `muted` otherwise.
 */
export type SubagentHue = "live" | "attn" | "fail" | "muted";

/** How a subagent stands, in the words a screen shows, and for how long. */
export interface SubagentState {
  readonly word: "working" | "waiting on you" | "done" | "failed" | "stopped";
  readonly hue: SubagentHue;
  /** How long it has run so far, or how long it ran, such as "2m 20s". */
  readonly duration: string;
}

/** A line of text and the colour it is drawn in. */
export interface SubagentLine {
  readonly text: string;
  readonly hue: SubagentHue;
}

/**
 * Returns the name a screen shows for the agent that started `subagent`:
 * its parent subagent's name, or "the main agent" when the session's own
 * agent started it. `subagents` are the session's subagents.
 */
export const nameSubagentParent = (subagent: Subagent, subagents: readonly Subagent[]): string => {
  const parent = subagents.find((each) => each.id === subagent.parentSubagentId);
  return parent === undefined ? "the main agent" : nameSubagent(parent);
};

/**
 * Checks whether a subagent waits on the user: one of `openRequests`, the
 * session's open Requests, is its own. It is the same rule the thread's
 * waiting mark follows, whoever asked, so every screen agrees on who waits.
 */
export const isSubagentWaiting = (
  subagent: Subagent,
  openRequests: readonly SessionRequest[],
): boolean => openRequests.some((request) => request.subagentId === subagent.id);

/**
 * Returns how long a subagent has run, in milliseconds: from its start until
 * `now` while it runs, and until it ended once it has.
 */
const measureSubagentDuration = (subagent: Subagent, now: Date): number => {
  const end =
    subagent.status === "running" || subagent.endedAt === undefined
      ? now.getTime()
      : Date.parse(subagent.endedAt);
  return end - Date.parse(subagent.startedAt);
};

/**
 * Returns how a subagent stands, as its state word, the colour of that word
 * and its duration. `waiting` is whether it waits on the user, as
 * `isSubagentWaiting` decides; it changes the word only while the subagent
 * runs.
 */
export const describeSubagentState = (
  subagent: Subagent,
  waiting: boolean,
  now: Date,
): SubagentState => {
  const duration = formatDuration(measureSubagentDuration(subagent, now));
  switch (subagent.status) {
    case "running":
      return waiting
        ? { word: "waiting on you", hue: "attn", duration }
        : { word: "working", hue: "live", duration };
    case "completed":
      return { word: "done", hue: "muted", duration };
    case "failed":
      return { word: "failed", hue: "fail", duration };
    case "stopped":
      return { word: "stopped", hue: "muted", duration };
  }
};

/**
 * The mark drawn beside a subagent: `working` while it runs, `waiting` while
 * it runs and waits on the user, and `done`, `failed` or `stopped` once it
 * has ended. Each app draws its own glyph or face for each mark.
 */
export type SubagentMark = "working" | "waiting" | "done" | "failed" | "stopped";

/**
 * Returns the mark of a subagent with `status`. `waiting` is whether it
 * waits on the user, as `isSubagentWaiting` decides; it changes the mark only
 * while the subagent runs.
 */
export const decideSubagentMark = (status: SubagentStatus, waiting: boolean): SubagentMark => {
  switch (status) {
    case "running":
      return waiting ? "waiting" : "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

/**
 * Returns the pose of a subagent's face, from the same rules as
 * `decideSubagentMark`. A face has no stopped pose, so a stopped subagent
 * is `idle`: it does nothing, and it is neither done nor failed.
 */
export const decideSubagentPose = (status: SubagentStatus, waiting: boolean): Pose => {
  const mark = decideSubagentMark(status, waiting);
  return mark === "stopped" ? "idle" : mark;
};

/** Returns what the user is asked to do about a Request, such as "allow a command". */
const describeRequestAsk = (request: SessionRequest): string => {
  switch (request.kind) {
    case "command_approval":
      return "allow a command";
    case "file_change_approval":
      return "allow a file change";
    case "file_read_approval":
      return "allow a file read";
    case "tool_approval":
      return "allow a tool";
    case "question":
      return "answer a question";
  }
};

/**
 * Returns the one line a screen shows under a subagent's name:
 *
 * - while one of `openRequests`, the session's open Requests, is its own,
 *   what it waits on the user for, such as "Waiting on you to allow a
 *   command";
 * - while it runs otherwise, what it is doing now, its `activity`;
 * - once it has ended, the first line of its last message, its `result`.
 *
 * Returns null when the record holds no such text yet.
 */
export const describeSubagentLine = (
  subagent: Subagent,
  openRequests: readonly SessionRequest[],
): SubagentLine | null => {
  const openRequest = openRequests.find((request) => request.subagentId === subagent.id);
  if (openRequest !== undefined) {
    return { text: `Waiting on you to ${describeRequestAsk(openRequest)}`, hue: "attn" };
  }
  if (subagent.status === "running") {
    return subagent.activity === undefined ? null : { text: subagent.activity, hue: "live" };
  }
  if (subagent.result === undefined) return null;
  return { text: subagent.result, hue: subagent.status === "failed" ? "fail" : "muted" };
};

/**
 * Formats a token count the short way a row has room for: "950", "41.7k",
 * "1.2M". Thousands and millions keep one decimal.
 */
export const formatTokenCount = (tokens: number): string => {
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 100) / 10;
  if (thousands < 1000) return `${thousands.toFixed(1)}k`;
  return `${(Math.round(tokens / 100_000) / 10).toFixed(1)}M`;
};

/**
 * Returns the token count of a subagent's own Token Usage, formatted by
 * `formatTokenCount`, or undefined when the harness reported no exact count.
 * A count that is not known is left out, never shown as 0.
 */
export const formatSubagentTokens = (subagent: Subagent): string | undefined =>
  subagent.usage === undefined ? undefined : formatTokenCount(countUsedTokens(subagent.usage));

/**
 * Returns the facts line of a subagent, such as
 * "Explore · claude-sonnet-5 · 41.7k tok · 5 tools". The agent type, the
 * model and the tokens are left out when the record does not hold them.
 */
export const describeSubagentMeta = (subagent: Subagent): string => {
  const tokens = formatSubagentTokens(subagent);
  const tools = `${String(subagent.toolCalls)} ${subagent.toolCalls === 1 ? "tool" : "tools"}`;
  return [
    subagent.agentType,
    subagent.model,
    tokens === undefined ? undefined : `${tokens} tok`,
    tools,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
};

/** The Stop button of a running subagent: its label, and its tooltip when it has one. */
export interface SubagentStop {
  readonly label: string;
  readonly title: string | undefined;
}

/**
 * Returns the Stop button of `subagent`, or null once it has ended and there
 * is nothing to stop. Stopping a subagent stops every subagent below it too,
 * so the label says how many: "Stop", or "Stop with 2 below", with a tooltip
 * that says so. `subagents` are the session's subagents.
 */
export const describeSubagentStop = (
  subagent: Subagent,
  subagents: readonly Subagent[],
): SubagentStop | null => {
  if (subagent.status !== "running") return null;
  const below = listSubagentDescendants(subagent, subagents).length;
  if (below === 0) return { label: "Stop", title: undefined };
  return {
    label: `Stop with ${String(below)} below`,
    title:
      below === 1
        ? "Also stops the subagent below it"
        : `Also stops the ${String(below)} subagents below it`,
  };
};
