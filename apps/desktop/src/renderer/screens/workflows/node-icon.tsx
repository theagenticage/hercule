/** PROTOTYPE. The icon that says what a node of the workflow graph is. */
import type { JSX } from "react";
import { AgentIcon } from "../../icons/agent";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { PuzzleIcon } from "../../icons/puzzle";
import type { GraphNode } from "./graph-model";

/**
 * Renders the icon of a node: AgentIcon for an agent step, a puzzle piece
 * for an action step, and a clock or a bolt for a trigger that fires on a
 * schedule or on an event.
 */
export function NodeIcon({
  kind,
  firesOnSchedule,
}: Pick<GraphNode, "kind" | "firesOnSchedule">): JSX.Element {
  switch (kind) {
    case "agent":
      return <AgentIcon size={14} />;
    case "action":
      return <PuzzleIcon size={14} />;
    default:
      return firesOnSchedule ? <ClockIcon size={14} /> : <BoltIcon size={14} />;
  }
}
