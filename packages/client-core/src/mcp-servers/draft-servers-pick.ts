/**
 * How a Draft Thread takes a choice in the composer's MCP servers menu. It is
 * apart from `thread-servers.ts` because that file is part of the desktop
 * app's first screen and this one is not.
 */
import type { McpServer } from "@hercule/contract";
import type { ThreadChoice } from "../threads/thread-choice";
import { decideMcpListChoice, type McpListChoice } from "./list-edits";
import { decideThreadStartSource, type StartProjectRecord, type StartRecord } from "./start-list";

/**
 * Returns the pick to record for `choice` on a Draft Thread, or `undefined`
 * when the choice changes nothing, or cannot be decided yet. A Draft Thread
 * writes nothing: its choice is decided by the rules a started thread uses
 * (`decideMcpListChoice`) and kept with the draft's other picks.
 *
 * `ids` is the list the draft shows now, `servers` the server records as the
 * cache holds them when the user pressed (no display data is needed), and `project` and `defaultIds` the start
 * records, so a reset goes back to the list the draft starts from. A reset
 * while where the list started is unknown, or incomplete, changes nothing.
 */
export const decideDraftServersPick = ({
  projectId,
  ids,
  servers,
  project,
  defaultIds,
  choice,
}: {
  readonly projectId: string | null;
  readonly ids: readonly string[];
  readonly servers: readonly McpServer[];
  readonly project: StartProjectRecord;
  readonly defaultIds: StartRecord<readonly string[]>;
  readonly choice: McpListChoice;
}): ThreadChoice | undefined => {
  const source = decideThreadStartSource({
    projectId,
    project,
    defaultIds,
    knownServerIds: new Set(servers.map((server) => server.id)),
  });
  const decided = decideMcpListChoice({
    ids,
    servers,
    choice,
    start: source.kind === "start" ? source.start : undefined,
  });
  return decided.kind === "write"
    ? { kind: "mcpServers", projectId, mcpServerIds: [...decided.mcpServerIds] }
    : undefined;
};
