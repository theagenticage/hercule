/**
 * Checks a plugin's mark, the small icon the apps draw beside its name
 * (spec 05 §2).
 *
 * The apps put each string of the mark into the `d` attribute of an SVG
 * `<path>`, so the host lets through path data only: commands, numbers,
 * signs, commas and spaces. A string with anything else in it could break out
 * of the attribute. A mark that fails the check is dropped, not the plugin:
 * the apps then draw the plugin's initial, and Settings > Plugins shows why.
 */
import { findIconPathsProblem, type PluginMark } from "@hercule/plugin-host";
import { convertExactColorToHex, describeExactColor } from "./colors";

/**
 * Checks a plugin's mark. Returns `{ mark }` when its paths can be drawn (see
 * `findIconPathsProblem`) and its colour, if it has one, is a CSS colour. The
 * returned mark has every colour as a hex code. Returns `{ markError }` with
 * one sentence for the user otherwise, and an empty object for a plugin with
 * no mark.
 */
export const checkPluginMark = (
  mark: PluginMark | undefined,
): { readonly mark?: PluginMark; readonly markError?: string } => {
  if (mark === undefined) return {};
  const problem = findIconPathsProblem(mark.paths);
  if (problem !== undefined) {
    return { markError: `The plugin's mark was left out because ${problem}.` };
  }
  if (mark.color === undefined) return { mark };
  const color = convertExactColorToHex(mark.color);
  if (color === undefined) {
    return {
      markError: `The plugin's mark was left out because its colour ${describeExactColor(mark.color)} is not a CSS colour. Write a hex code such as "#8250df" or a CSS colour name such as "purple".`,
    };
  }
  return { mark: { ...mark, color } };
};
