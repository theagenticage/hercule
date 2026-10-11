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

/**
 * The most bytes of UTF-8 all of a mark's paths may hold together. A 16x16
 * icon needs a few hundred.
 */
export const MAX_MARK_BYTES = 4 * 1024;

/**
 * The most paths a mark may have. A 16x16 icon needs a handful, and the apps
 * draw every path of every plugin's mark wherever the plugin is named.
 */
export const MAX_MARK_PATHS = 16;

/** The characters SVG path data is written with: commands, digits, signs, separators. */
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;

/**
 * Checks a plugin's mark. Returns `{ mark }` when it has at most
 * `MAX_MARK_PATHS` paths, every path is path data, and the paths together
 * hold at most `MAX_MARK_BYTES`, and `{ markError }` with one sentence for
 * the user otherwise. Returns an empty object for a plugin with no mark.
 */
export const checkPluginMark = (
  mark: PluginMark | undefined,
): { readonly mark?: PluginMark; readonly markError?: string } => {
  if (mark === undefined) return {};
  if (mark.paths.length === 0) {
    return { markError: "The plugin's mark was left out because it has no paths." };
  }
  if (mark.paths.length > MAX_MARK_PATHS) {
    return {
      markError: `The plugin's mark was left out because it has ${String(mark.paths.length)} paths, and a mark may have at most ${String(MAX_MARK_PATHS)}.`,
    };
  }
  const bytes = mark.paths.reduce(
    (total, path) => total + new TextEncoder().encode(path).byteLength,
    0,
  );
  if (bytes > MAX_MARK_BYTES) {
    return {
      markError: "The plugin's mark was left out because its paths together are larger than 4 KB.",
    };
  }
  if (!mark.paths.every((path) => PATH_DATA.test(path))) {
    return {
      markError:
        "The plugin's mark was left out because one of its paths holds something other than SVG path data.",
    };
  }
  return { mark };
};
