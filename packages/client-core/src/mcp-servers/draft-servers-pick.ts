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
 * Returns the choice to record for `choice` on a Draft Thread, or `undefined`
 * when it cannot be decided yet. A Draft Thread writes nothing: its choice is
 * decided by the rules a started thread uses (`decideMcpListChoice`) and kept
 * with the draft's other picks.
 *
 * - `ids` is the list the draft shows now. It is used while the draft holds
 *   no pick for the project. Once it does, the pick is the list the choice
 *   applies to, with the servers the cache no longer has left out, so two
 *   choices recorded before the screen draws again both count.
 * - `servers` is the server records as the cache holds them when the user
 *   pressed (no display data is needed).
 * - `project` and `defaultIds` are the start records, so a reset goes back to
 *   the list the draft starts from. A reset while where the list started is
 *   unknown, or incomplete, returns `undefined`.
 * - A reset returns the choice that forgets the pick, so the draft follows
 *   its start list again, later changes to that list included.
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
  const knownServerIds = new Set(servers.map((server) => server.id));
  const source = decideThreadStartSource({ projectId, project, defaultIds, knownServerIds });
  if (choice.kind === "reset") {
    return source.kind === "start" ? { kind: "mcpServersReset" } : undefined;
  }
  return {
    kind: "mcpServers",
    projectId,
    decideMcpServerIds: (pickedIds) => {
      const decided = decideMcpListChoice({
        ids: pickedIds === undefined ? ids : pickedIds.filter((id) => knownServerIds.has(id)),
        servers,
        choice,
        start: source.kind === "start" ? source.start : undefined,
      });
      return decided.kind === "write" ? [...decided.mcpServerIds] : undefined;
    },
  };
};
