/** The icon that shows what kind of node a node of the workflow graph is. */
import type { JSX } from "react";
import type { GraphNode } from "@hercule/client-core/graph-model";
import { AgentIcon } from "../../icons/agent";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { PuzzleIcon } from "../../icons/puzzle";

/**
 * Renders the 14px icon of a node: AgentIcon for an agent step, a puzzle
 * piece for an action step, and a clock or a bolt for a trigger that fires on
 * a schedule or on an event.
 */
export function NodeIcon({ kind, firesOn }: Pick<GraphNode, "kind" | "firesOn">): JSX.Element {
  switch (kind) {
    case "agent":
      return <AgentIcon size={14} />;
    case "action":
      return <PuzzleIcon size={14} />;
    default:
      return firesOn === "schedule" ? <ClockIcon size={14} /> : <BoltIcon size={14} />;
  }
}
