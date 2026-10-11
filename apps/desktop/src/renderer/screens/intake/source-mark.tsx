import type { PluginIdentity } from "@hercule/client-core";
import type { JSX } from "react";
import { LogoMark } from "../../logos/logo-mark";
import { PluginMark } from "../../marks";

/**
 * Renders the mark of a signal's source, `size` CSS pixels square: the logo
 * mark for the core, `null`, or otherwise the plugin's mark as `PluginMark`
 * draws it. The mark is hidden from assistive technology, because the row,
 * the pane and the tabs name the source in words.
 */
export function SourceMark({
  pluginId,
  plugins,
  size,
}: {
  /** The plugin the signal comes from, as `parsePluginId` returns it, or `null` for the core. */
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  if (pluginId === null) return <LogoMark size={size} />;
  return <PluginMark pluginId={pluginId} plugins={plugins} size={size} />;
}
