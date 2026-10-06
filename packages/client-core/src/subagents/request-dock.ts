/**
 * Decides which open Request the dock on the composer shows, how the user
 * pages to the others, and which agent asked it.
 */
import type { SessionRequest, Subagent, SubagentId } from "@hercule/contract";
import { nameSubagent } from "./describe";

/** The subagent that asked the shown Request, and the agent that started it. */
export interface RequestAsker {
  readonly subagentId: SubagentId;
  readonly name: string;
  /**
   * The name of the agent that started the asker: a subagent's name, or "the
   * main agent". Null when the asker's record has not been read yet, so its
   * parent is not known.
   */
  readonly parentName: string | null;
}

/** What the Request dock shows. */
export interface RequestDock {
  readonly request: SessionRequest;
  /** Where the shown Request is among the open ones, counted from 1. Null when only one is open. */
  readonly position: { readonly at: number; readonly of: number } | null;
  /** The Request the pager's back arrow shows; undefined on the first one. */
  readonly previousRequestId: string | undefined;
  /** The Request the pager's forward arrow shows; undefined on the last one. */
  readonly nextRequestId: string | undefined;
  /** The subagent that asked; null when the session's own agent asked. */
  readonly asker: RequestAsker | null;
  /**
   * Whether the thread page draws the line above the card that pages and
   * names the asker. It does when several Requests are open, or when a
   * subagent asked. A lone Request of the main agent has no line, because
   * the card is then plainly the thread's own.
   */
  readonly showsAskerLine: boolean;
}

/** Returns the asker of a subagent's Request, read from `subagents`. */
const buildAsker = (subagentId: SubagentId, subagents: readonly Subagent[]): RequestAsker => {
  const subagent = subagents.find((each) => each.id === subagentId);
  if (subagent === undefined) return { subagentId, name: "A subagent", parentName: null };
  const parent = subagents.find((each) => each.id === subagent.parentSubagentId);
  return {
    subagentId,
    name: nameSubagent(subagent),
    parentName: parent === undefined ? "the main agent" : nameSubagent(parent),
  };
};

/**
 * Builds what the Request dock shows from `requests`, the open Requests it
 * pages through, oldest first. It shows the Request `shownRequestId` names;
 * when that one is no longer open, or none is named, it shows the oldest.
 * Returns null when no Request is open.
 *
 * On a subagent's page, `requests` are that subagent's own, and the page
 * draws the pager without the asker's name, because the page already names
 * it.
 */
export const buildRequestDock = (
  requests: readonly SessionRequest[],
  subagents: readonly Subagent[],
  shownRequestId: string | undefined,
): RequestDock | null => {
  const found = requests.findIndex((request) => request.requestId === shownRequestId);
  const index = found === -1 ? 0 : found;
  const request = requests[index];
  if (request === undefined) return null;
  const asker = request.subagentId === undefined ? null : buildAsker(request.subagentId, subagents);
  return {
    request,
    position: requests.length > 1 ? { at: index + 1, of: requests.length } : null,
    previousRequestId: index > 0 ? requests[index - 1]?.requestId : undefined,
    nextRequestId: requests[index + 1]?.requestId,
    asker,
    showsAskerLine: requests.length > 1 || asker !== null,
  };
};
