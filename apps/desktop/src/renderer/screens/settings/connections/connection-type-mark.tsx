import type { JSX } from "react";
import { parsePluginId, type PluginIdentity } from "@hercule/client-core";
import { ConnectionsIcon } from "../../../icons/connections";
import { PluginMark } from "../../../marks/plugin-mark";

/**
 * Renders the mark of the Connection type `type`, `size` pixels square, 16
 * unless given: the mark of the plugin that declares it (`PluginMark`, which falls back to the
 * plugin's initial). A type is always qualified by its plugin's id, as in
 * `github/github`, so the plug icon drawn for a type with no plugin id is
 * only a guard against a malformed type.
 */
export function ConnectionTypeMark({
  type,
  plugins,
  size = 16,
}: {
  /** The Connection type, as a Connection or the plugin list holds it. */
  readonly type: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size?: number;
}): JSX.Element {
  const pluginId = parsePluginId(type);
  return pluginId === null ? (
    <ConnectionsIcon size={size} />
  ) : (
    <PluginMark pluginId={pluginId} plugins={plugins} size={size} />
  );
}
