import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { groupProfileUsers } from "@hercule/client-core";
import { useAssistantRows } from "../../../../../app/assistant-rows";
import { agentsQuery, assistantsQuery } from "../../../../../app/queries";
import type { PosedProfileUser } from "../../../../../screens/settings/permission-profiles/profile-user-face";

/**
 * Returns the agents and assistants of each permission profile, by profile
 * id, as `groupProfileUsers` groups them, each with the pose its face shows.
 * A profile nobody uses has no entry.
 *
 * An assistant shows the pose of the sidebar's row. An agent shows `idle`,
 * because no read says what an agent is doing: its sessions are not listed
 * by agent.
 */
export function useProfileUsers(): ReadonlyMap<string, ReadonlyArray<PosedProfileUser>> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const agents = useSuspenseQuery(agentsQuery(client)).data;
  const assistants = useSuspenseQuery(assistantsQuery(client)).data;
  const poses = new Map(useAssistantRows().map(({ id, pose }) => [id, pose]));
  return new Map(
    [...groupProfileUsers(agents, assistants)].map(([profileId, users]) => [
      profileId,
      users.map((user) => ({ ...user, pose: poses.get(user.id) ?? "idle" })),
    ]),
  );
}
