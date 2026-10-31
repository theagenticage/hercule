import type { JSX } from "react";
import { decidePluginMark, type PluginIdentity } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * Draws the mark of the plugin that registered a Provider, in the current
 * text colour, like `HarnessLogo`:
 *
 * - the mark the plugin declares, each path on a 16 by 16 grid;
 * - otherwise the initial of the plugin's name in a rounded square, when the
 *   plugin declares no mark, the core dropped it, or `plugins` does not list
 *   the plugin.
 *
 * Draws nothing when `pluginId` is `null`, which means no plugin registers the
 * account's Provider any more. The app never draws an SVG of the plugin's own
 * and the mark is hidden from assistive technology, because the account's name
 * stands beside it.
 */
export function ProviderMark({
  pluginId,
  plugins,
  className,
}: {
  /** The id of the plugin that registered the Provider, as `findProviderPluginId` returns it. */
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly className?: string;
}): JSX.Element | null {
  if (pluginId === null) return null;
  const drawing = decidePluginMark(pluginId, plugins);
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      viewBox="0 0 16 16"
      className={cn("size-[13px] shrink-0", className)}
    >
      {drawing._tag === "paths" ? (
        drawing.paths.map((path, index) => <path key={index} d={path} />)
      ) : (
        <>
          <rect x="1" y="1" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" />
          <text x="8" y="11.5" textAnchor="middle" fontSize="9.5" fontWeight="700">
            {drawing.initial}
          </text>
        </>
      )}
    </svg>
  );
}
