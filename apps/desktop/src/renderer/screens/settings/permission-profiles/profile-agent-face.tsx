import type { JSX } from "react";
import type { Pose, ProfileAgent } from "@hercule/client-core";
import { buildAssistantLook, buildLook, Face } from "../../../faces";

/** An agent that carries a permission profile, with the pose its face shows. */
export interface PosedProfileAgent extends ProfileAgent {
  readonly pose: Pose;
}

/**
 * Renders the face of `agent`, `size` CSS pixels square, in the look its id
 * gives. An assistant wears its headwear, as it does everywhere else.
 */
export function ProfileAgentFace({
  agent,
  size,
}: {
  readonly agent: PosedProfileAgent;
  readonly size: number;
}): JSX.Element {
  const look = agent.kind === "assistant" ? buildAssistantLook(agent.id) : buildLook(agent.id);
  return <Face look={look} pose={agent.pose} size={size} />;
}
