/**
 * A subagent's face. A subagent has a face of its own, seeded by its session
 * id and its subagent id together, so its hue and shape never change and
 * never match another subagent's by accident (spec 17 §Thread, Subagents).
 */
import type { JSX } from "react";
import { decideSubagentPose } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { Face, buildLook, type Look } from "../../faces";

/** Builds the seed of the face of the subagent `subagentId` of the session `sessionId`. */
export const buildSubagentFaceSeed = (sessionId: string, subagentId: string): string =>
  `${sessionId}:${subagentId}`;

/** Builds the look of `subagent`'s face, whose hue also tints its crumb and its brief. */
export const buildSubagentLook = (subagent: Subagent): Look =>
  buildLook(buildSubagentFaceSeed(subagent.sessionId, subagent.id));

/**
 * Renders `subagent`'s face, `size` CSS pixels square, in the pose its status
 * and `waiting` decide. The face never moves: only the face of the open
 * page's running turn animates, and the transcript draws that one (spec 17
 * §Rules, rule 2).
 */
export function SubagentFace({
  subagent,
  waiting,
  size,
}: {
  readonly subagent: Subagent;
  readonly waiting: boolean;
  readonly size: number;
}): JSX.Element {
  return (
    <Face
      look={buildSubagentLook(subagent)}
      pose={decideSubagentPose(subagent.status, waiting)}
      size={size}
    />
  );
}
