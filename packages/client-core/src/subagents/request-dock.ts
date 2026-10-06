/**
 * Decides which open Request the dock on the composer shows, how the user
 * pages to the others, and which agent asked it.
 */
import type { SessionRequest, Subagent, SubagentId } from "@hercule/contract";
import { nameSubagentParent } from "./describe";
import { nameSubagent } from "./name";

/**
 * The agent that asked the shown Request: the session's own agent, or a
 * subagent, named with the agent that started it.
 */
export type RequestAsker =
  | { readonly kind: "main agent" }
  | {
      readonly kind: "subagent";
      readonly subagentId: SubagentId;
      readonly name: string;
      /**
       * The name of the agent that started the asker: a subagent's name, or
       * "the main agent". Null when the asker's record has not been read
       * yet, so its parent is not known.
       */
      readonly parentName: string | null;
    };

/** What the Request dock shows. */
export interface RequestDockState {
  readonly request: SessionRequest;
  /** Where the shown Request is among the open ones, counted from 1. Null when only one is open. */
  readonly position: { readonly at: number; readonly of: number } | null;
  /** The Request the pager's back arrow shows; undefined on the first one. */
  readonly previousRequestId: string | undefined;
  /** The Request the pager's forward arrow shows; undefined on the last one. */
  readonly nextRequestId: string | undefined;
  /**
   * The agent the line above the card names. Null on a subagent's page,
   * which already names the subagent.
   */
  readonly asker: RequestAsker | null;
  /**
   * Whether the line above the card, which pages and names the asker, is
   * drawn. On the thread's page it is drawn when several Requests are open,
   * or when a subagent asked: a lone Request of the main agent has no line,
   * because the card is then plainly the thread's own. On a subagent's page
   * it is drawn only when several Requests are open, for the arrows.
   */
  readonly showsAskerLine: boolean;
}

/**
 * Returns the asker of a subagent's Request, read from `subagents`. Until
 * the subagent's record has been read, its name is `subagentName`, the one
 * the controller put on the Request, else "A subagent".
 */
const buildSubagentAsker = (
  subagentId: SubagentId,
  subagentName: string | undefined,
  subagents: readonly Subagent[],
): RequestAsker => {
  const subagent = subagents.find((each) => each.id === subagentId);
  if (subagent === undefined) {
    return { kind: "subagent", subagentId, name: subagentName ?? "A subagent", parentName: null };
  }
  return {
    kind: "subagent",
    subagentId,
    name: nameSubagent(subagent),
    parentName: nameSubagentParent(subagent, subagents),
  };
};

/**
 * Builds what the Request dock shows, or returns null when it has nothing
 * to show.
 *
 * - `openRequests` are the session's open Requests, oldest first.
 * - `pageSubagentId` is the subagent whose page the dock is on; the dock
 *   then pages through that subagent's own Requests only. Undefined on the
 *   thread's page, where it pages through all of them.
 * - `shownRequestId` is the Request the user paged to. When it is no longer
 *   open, or none is named, the dock shows the oldest.
 */
export const buildRequestDock = (
  openRequests: readonly SessionRequest[],
  subagents: readonly Subagent[],
  pageSubagentId: SubagentId | undefined,
  shownRequestId: string | undefined,
): RequestDockState | null => {
  const requests =
    pageSubagentId === undefined
      ? openRequests
      : openRequests.filter((request) => request.subagentId === pageSubagentId);
  const found = requests.findIndex((request) => request.requestId === shownRequestId);
  const index = found === -1 ? 0 : found;
  const request = requests[index];
  if (request === undefined) return null;
  const asker: RequestAsker | null =
    pageSubagentId !== undefined
      ? null
      : request.subagentId === undefined
        ? { kind: "main agent" }
        : buildSubagentAsker(request.subagentId, request.subagentName, subagents);
  return {
    request,
    position: requests.length > 1 ? { at: index + 1, of: requests.length } : null,
    previousRequestId: index > 0 ? requests[index - 1]?.requestId : undefined,
    nextRequestId: requests[index + 1]?.requestId,
    asker,
    showsAskerLine: requests.length > 1 || asker?.kind === "subagent",
  };
};

/**
 * Who asks the shown Request, in the words the line above the dock shows:
 * "<name> asks · subagent of <parent>", or "The main agent asks". The parts
 * are kept apart so each app can draw the subagent's name in its own style.
 */
export interface RequestAskerWords {
  /** The asking subagent's name; null when the main agent asks. */
  readonly name: string | null;
  /** The words after the name, "asks", or "The main agent asks" when there is no name. */
  readonly asks: string;
  /**
   * Who started the asking subagent, such as "subagent of the main agent".
   * Null when the main agent asks, or when the asker's record has not been
   * read yet, so its parent is not known.
   */
  readonly parent: string | null;
}

/** Returns the words that name `asker` on the line above the dock. */
export const describeRequestAsker = (asker: RequestAsker): RequestAskerWords =>
  asker.kind === "main agent"
    ? { name: null, asks: "The main agent asks", parent: null }
    : {
        name: asker.name,
        asks: "asks",
        parent: asker.parentName === null ? null : `subagent of ${asker.parentName}`,
      };
