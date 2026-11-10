import type { PluginColorDrawing } from "@hercule/client-core";
import type { CSSProperties } from "react";

/**
 * Returns the inline style that draws in a plugin's colour, as
 * `decidePluginColor` decides it, or `undefined` when the plugin declares no
 * colour and the element keeps the colour its stylesheet gives it.
 *
 * - A hue is drawn at the theme's lightness and strength (`--mark-l`,
 *   `--mark-c`), so no plugin's hue is louder than a name in any theme.
 * - An exact colour picks its light or dark value with `light-dark()`, which
 *   follows the `color-scheme` every theme sets.
 */
export const buildPluginColorStyle = (
  drawing: PluginColorDrawing | undefined,
): CSSProperties | undefined => {
  if (drawing === undefined) return undefined;
  return {
    color:
      drawing._tag === "hue"
        ? `oklch(var(--mark-l) var(--mark-c) ${String(drawing.hue)})`
        : `light-dark(${drawing.light}, ${drawing.dark})`,
  };
};
