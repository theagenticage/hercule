import type { JSX } from "react";
import { parsePluginId, type PluginIdentity } from "@hercule/client-core";
import { CpuIcon } from "../../../icons/cpu";
import { PluginMark } from "../../../marks/plugin-mark";

/**
 * Renders the mark of the Provider `providerId`, `size` pixels square: the
 * mark of the plugin that registers it (`PluginMark`, which falls back to
 * the plugin's initial). A provider is always qualified by its plugin's id,
 * as in `anthropic/anthropic`, so the chip drawn for an id with no plugin
 * part is only a guard against a malformed id.
 */
export function ProviderMark({
  providerId,
  plugins,
  size,
}: {
  /** The qualified id of the Provider, as an account holds it. */
  readonly providerId: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  const pluginId = parsePluginId(providerId);
  return pluginId === null ? (
    <CpuIcon size={size} />
  ) : (
    <PluginMark pluginId={pluginId} plugins={plugins} size={size} />
  );
}
