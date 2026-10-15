/** The icon that shows what kind of node a node of the workflow graph is. */
import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { GraphNode } from "@hercule/client-core/graph-model";
import { AgentIcon } from "../../icons/agent";
import { BoltIcon } from "../../icons/bolt";
import { ClockIcon } from "../../icons/clock";
import { PuzzleIcon } from "../../icons/puzzle";
import { SparkleIcon } from "../../icons/sparkle";
import { PluginMark } from "../../marks";

/**
 * Renders the 14px icon of a node:
 *
 * - AgentIcon for an agent step;
 * - a sparkle for a text generation step, the icon the app draws for text
 *   generation elsewhere too;
 * - for an action step, the mark of the plugin whose action it calls, drawn
 *   from `plugins`, or a puzzle piece for a built-in action, as the Bureau
 *   book draws every action;
 * - a clock or a bolt for a trigger that fires on a schedule or on an event.
 */
export function NodeIcon({
  kind,
  firesOn,
  pluginId,
  plugins,
}: Pick<GraphNode, "kind" | "firesOn" | "pluginId"> & {
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  switch (kind) {
    case "agent":
      return <AgentIcon size={14} />;
    case "text-generation":
      return <SparkleIcon size={14} />;
    case "action":
      return pluginId === null ? (
        <PuzzleIcon size={14} />
      ) : (
        <PluginMark pluginId={pluginId} plugins={plugins} size={14} />
      );
    default:
      return firesOn === "schedule" ? <ClockIcon size={14} /> : <BoltIcon size={14} />;
  }
}
