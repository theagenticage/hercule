import type { JSX } from "react";
import type { Pose, ProfileAgent } from "@hercule/client-core";
import { buildLook, Face } from "../../../faces";

/** An agent that carries a permission profile, with the pose its face shows. */
export interface PosedProfileAgent extends ProfileAgent {
  readonly pose: Pose;
}

/** Renders the face of `agent`, `size` CSS pixels square, in the look its id gives. */
export function ProfileAgentFace({
  agent,
  size,
}: {
  readonly agent: PosedProfileAgent;
  readonly size: number;
}): JSX.Element {
  return <Face look={buildLook(agent.id)} pose={agent.pose} size={size} />;
}
