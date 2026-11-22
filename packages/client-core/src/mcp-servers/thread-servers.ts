/**
 * What an open thread knows of its MCP Servers, decided from records alone:
 * its list, where the list started, what it must read, and the words on the
 * composer's `+`. A started thread and a Draft Thread (an unsent thread, which
 * keeps its list as a pick) are described the same way, so the web app and the
 * desktop app each have one owner of these rules per open thread.
 *
 * This file imports no code that joins servers with their Connections
 * (`views.ts`) or edits a list (`list-edits.ts`), because the desktop app's
 * first screen draws the `+` with it.
 */
import type { McpServer, Session } from "@hercule/contract";
import {
  decideThreadStartSource,
  type StartProjectRecord,
  type StartRecord,
  type ThreadStartDecision,
} from "./start-list";
import { describeThreadServersRow, type ThreadServersRow } from "./thread-servers-row";

/** The thread whose servers are described. */
export type ThreadServersSubject =
  /**
   * An unsent thread in the project `projectId` (`null` for none). `pickedIds`
   * is the list the user changed it to, as `resolveDraftMcpServerIds` returns
   * it: `undefined` while the list is untouched, or picked for another project.
   */
  | {
      readonly kind: "draft";
      readonly projectId: string | null;
      readonly pickedIds: readonly string[] | undefined;
    }
  /** A thread that has started: its list is `session.mcpServers`. */
  | { readonly kind: "started"; readonly session: Session };

/**
 * What an app knows of a thread's servers without reading more: the records
 * it holds now. A record it has not read is `pending`, never left out.
 */
export interface ThreadServersRecords {
  readonly thread: ThreadServersSubject;
  /** The thread's project, which decides the list it started from. Read only when the thread is in one. */
  readonly project: StartProjectRecord;
  /** The default list, which a thread in no project starts from. */
  readonly defaultIds: StartRecord<readonly string[]>;
  /** Whether the thread's transcript holds a line about MCP Servers. A draft has none. */
  readonly hasMcpLine: boolean;
  /** Whether the MCP row of the `+` menu or the picker is open, which is the one state that asks for the editor's reads. */
  readonly editing: boolean;
}

/** What a thread must read from the controller, which an app turns into reads and a live topic. */
export interface ThreadServersDemand {
  /** The list of servers, and the live topic `mcpServer` while it is wanted. */
  readonly catalogue: boolean;
  /** The servers joined with their Connections: the names and buttons of a line, and the menu's rows. */
  readonly views: boolean;
  /** The records of the list a thread started from, which the menu's foot and its reset need. */
  readonly start: boolean;
}

const readThreadProjectId = (thread: ThreadServersSubject): string | null =>
  thread.kind === "draft" ? thread.projectId : thread.session.projectId;

/**
 * Returns the ids of the thread's list as the records store them, before the
 * servers are read: a started thread's session, a draft's pick while it is in
 * the project the pick was made under, else the list the draft starts from.
 * It may name a server deleted since.
 */
const readStoredIds = ({
  thread,
  project,
  defaultIds,
}: Pick<ThreadServersRecords, "thread" | "project" | "defaultIds">): readonly string[] => {
  if (thread.kind === "started") return thread.session.mcpServers.map((each) => each.mcpServerId);
  if (thread.pickedIds !== undefined) return thread.pickedIds;
  if (thread.projectId !== null) return project.kind === "read" ? project.value.mcpServerIds : [];
  return defaultIds.kind === "read" ? defaultIds.value : [];
};

/**
 * Returns what the thread must read. It depends on the stored ids and not on
 * the servers read, so an app calls it before it has read them.
 *
 * - `catalogue`: the stored list is not empty, the transcript holds a line
 *   about MCP Servers, or the editor is open. A pick naming only servers
 *   deleted since still counts, so the topic is held until the servers say so.
 * - `views`: a line or the editor needs the joined servers.
 * - `start`: only the editor needs where the list started.
 *
 * A thread with no server, no line and no editor reads nothing.
 */
export const decideThreadServersDemand = (records: ThreadServersRecords): ThreadServersDemand => {
  const { hasMcpLine, editing } = records;
  return {
    catalogue: readStoredIds(records).length > 0 || hasMcpLine || editing,
    views: hasMcpLine || editing,
    start: editing,
  };
};

/** What `describeThreadServers` returns. */
export interface ThreadServersDescription {
  /** The thread's list as the records store it. It may name a server deleted since. */
  readonly storedIds: readonly string[];
  /**
   * The list the composer shows and a draft sends. Once the servers are read,
   * a draft's list leaves out ids no server has; a started thread's list is
   * the session's own.
   */
  readonly mcpServerIds: readonly string[];
  /** Where the list started, or why that is not known. `undefined` until the servers are read. */
  readonly start: ThreadStartDecision | undefined;
  /** The words and the red dot of the `+` menu's "MCP servers" row. */
  readonly row: ThreadServersRow;
}

/**
 * Describes the servers of a thread from `records` and the servers the
 * catalogue returned (`servers`, `undefined` until they are read).
 *
 * - A draft with a pick in its own project shows the pick, and otherwise the
 *   list it starts from: its project's, or for no project the default list.
 * - `start` is decided by `decideThreadStartSource`, so a record that is
 *   pending or failed, or a project that is gone, only takes away the way
 *   back to the start list.
 * - `row` takes the server records alone, so the first screen can draw it.
 */
export const describeThreadServers = (
  records: ThreadServersRecords,
  servers: readonly McpServer[] | undefined,
): ThreadServersDescription => {
  const { thread } = records;
  const storedIds = readStoredIds(records);
  const knownServerIds =
    servers === undefined ? undefined : new Set(servers.map((each) => each.id));
  const start =
    knownServerIds === undefined
      ? undefined
      : decideThreadStartSource({
          projectId: readThreadProjectId(thread),
          project: records.project,
          defaultIds: records.defaultIds,
          knownServerIds,
        });
  const mcpServerIds = decideShownIds(records, storedIds, start, knownServerIds);
  return {
    storedIds,
    mcpServerIds,
    start,
    row: describeThreadServersRow(servers ?? [], mcpServerIds),
  };
};

const decideShownIds = (
  { thread }: ThreadServersRecords,
  storedIds: readonly string[],
  start: ThreadStartDecision | undefined,
  knownServerIds: ReadonlySet<string> | undefined,
): readonly string[] => {
  if (thread.kind === "started") return storedIds;
  if (thread.pickedIds !== undefined) {
    return knownServerIds === undefined
      ? storedIds
      : storedIds.filter((id) => knownServerIds.has(id));
  }
  return start?.kind === "start" ? start.start.mcpServerIds : storedIds;
};
