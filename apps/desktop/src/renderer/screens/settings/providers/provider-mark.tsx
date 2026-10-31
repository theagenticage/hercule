import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { CpuIcon } from "../../../icons/cpu";
import { PluginMark } from "../../../marks/plugin-mark";

/**
 * Renders the mark of the plugin that registered a Provider, `size` pixels
 * square (`PluginMark`, which falls back to the plugin's initial). A plain
 * chip stands in when `pluginId` is `null`, because no plugin registers the
 * account's Provider any more.
 */
export function ProviderMark({
  pluginId,
  plugins,
  size,
}: {
  /** The id of the plugin that registered the Provider, or `null` when none does. */
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  return pluginId === null ? (
    <CpuIcon size={size} />
  ) : (
    <PluginMark pluginId={pluginId} plugins={plugins} size={size} />
  );
}
