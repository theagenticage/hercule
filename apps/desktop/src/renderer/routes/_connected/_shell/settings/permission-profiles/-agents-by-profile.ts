import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { groupAgentsByProfile } from "@hercule/client-core";
import { useAssistantRows } from "../../../../../app/assistant-rows";
import { agentsQuery, assistantsQuery } from "../../../../../app/queries";
import type { PosedProfileAgent } from "../../../../../screens/settings/permission-profiles/profile-agent-face";

/**
 * Returns the agents and assistants of each permission profile, by profile
 * id, as `groupAgentsByProfile` groups them, each with the pose its face
 * shows. A profile no agent carries has no entry.
 *
 * An assistant shows the pose of the sidebar's row. A plain agent shows
 * `idle`, because no read tells what an agent is doing: its sessions are not
 * listed by agent.
 */
export function useAgentsByProfile(): ReadonlyMap<string, ReadonlyArray<PosedProfileAgent>> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const agents = useSuspenseQuery(agentsQuery(client)).data;
  const assistants = useSuspenseQuery(assistantsQuery(client)).data;
  const poses = new Map(useAssistantRows().map(({ id, pose }) => [id, pose]));
  return new Map(
    [...groupAgentsByProfile(agents, assistants)].map(([profileId, inProfile]) => [
      profileId,
      inProfile.map((agent) => ({ ...agent, pose: poses.get(agent.id) ?? "idle" })),
    ]),
  );
}
