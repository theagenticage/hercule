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
import type { PluginMark } from "@hercule/plugin-host";

/** The largest path string, in bytes of UTF-8. A 16x16 icon needs a few hundred. */
export const MAX_MARK_PATH_BYTES = 4 * 1024;

/** The characters SVG path data is written with: commands, digits, signs, separators. */
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;

/**
 * Checks a plugin's mark. Returns `{ mark }` when every path is path data of
 * at most `MAX_MARK_PATH_BYTES`, and `{ markError }` with one sentence for
 * the user otherwise. Returns an empty object for a plugin with no mark.
 */
export const checkPluginMark = (
  mark: PluginMark | undefined,
): { readonly mark?: PluginMark; readonly markError?: string } => {
  if (mark === undefined) return {};
  if (mark.paths.length === 0) {
    return { markError: "The plugin's mark was left out because it has no paths." };
  }
  for (const path of mark.paths) {
    if (new TextEncoder().encode(path).byteLength > MAX_MARK_PATH_BYTES) {
      return {
        markError: "The plugin's mark was left out because one of its paths is larger than 4 KB.",
      };
    }
    if (!PATH_DATA.test(path)) {
      return {
        markError:
          "The plugin's mark was left out because one of its paths holds something other than SVG path data.",
      };
    }
  }
  return { mark };
};
