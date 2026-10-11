import { decidePluginMark, type PluginIdentity } from "@hercule/client-core";
import type { JSX } from "react";
import { LogoMark } from "../../logos/logo-mark";

/**
 * Renders the mark of a signal's source, `size` CSS pixels square:
 *
 * - the logo mark for the core, `null`;
 * - the mark the plugin declares, which the API returns with the plugin:
 *   each of its paths drawn in the text colour on a 16 by 16 grid (spec 17
 *   §Design system);
 * - otherwise, when the plugin declares no mark or the core dropped it, the
 *   initial of the plugin's name in a rounded square.
 *
 * The mark is hidden from assistive technology, because the row, the pane
 * and the tabs name the source in words.
 */
export function SourceMark({
  pluginId,
  plugins,
  size,
}: {
  /** The plugin the signal comes from, as `parseSignalPluginId` returns it, or `null` for the core. */
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  if (pluginId === null) return <LogoMark size={size} />;
  const drawing = decidePluginMark(pluginId, plugins);
  return (
    <svg
      className="br"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
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
