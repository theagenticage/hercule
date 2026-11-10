import { decidePluginColor, decidePluginMark, type PluginIdentity } from "@hercule/client-core";
import type { JSX } from "react";
import { buildPluginColorStyle } from "./plugin-color";
import "../logos/logos.css";

/** A solid mark carries more weight than a line drawing, so it is drawn this much smaller to look the same size. */
const SOLID_MARK_SCALE = 0.9;

/**
 * Renders the mark of the plugin `pluginId`, `size` CSS pixels square:
 *
 * - the mark the plugin declares, which the API returns with the plugin in
 *   `plugins`: each of its paths drawn in the text colour on a 16 by 16 grid
 *   (spec 17 §Design system);
 * - otherwise, when the plugin declares no mark, the core dropped it, or
 *   `plugins` does not hold the plugin, the initial of its name in a rounded
 *   square.
 *
 * A mark that declares `solid` is drawn at 90% of `size`. A mark that
 * declares a `hue` or a `color` is drawn in it (see `buildPluginColorStyle`),
 * and a mark with neither takes the text colour.
 *
 * The app never draws an SVG of the plugin's own, so a plugin's mark is
 * always drawn here. The mark is hidden from assistive technology, because
 * every place that draws one also names the plugin, or what it does, in words.
 */
export function PluginMark({
  pluginId,
  plugins,
  size,
}: {
  /** The plugin's id, as `parsePluginId` returns it: `github` for `github/pr.create`. */
  readonly pluginId: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly size: number;
}): JSX.Element {
  const drawing = decidePluginMark(pluginId, plugins);
  const declared = plugins.find((plugin) => plugin.id === pluginId)?.mark;
  const drawnSize = declared?.solid === true ? Math.round(size * SOLID_MARK_SCALE) : size;
  return (
    <svg
      className="br"
      style={
        declared === undefined ? undefined : buildPluginColorStyle(decidePluginColor(declared))
      }
      viewBox="0 0 16 16"
      width={drawnSize}
      height={drawnSize}
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
