/**
 * How the clients name and draw a plugin: its name, the colour it declares,
 * and its mark. The Inbox, Work, Settings and the native notifications all
 * use these functions, so a plugin looks the same everywhere.
 */
import type { ExactColor, PluginMark } from "@hercule/contract";

/** A plugin's id and the name the user knows it by, as `plugin.query` returns them. */
export interface PluginName {
  readonly id: string;
  readonly displayName: string;
}

/** A plugin's id, its name and the mark it declares, as `plugin.query` returns them. */
export interface PluginIdentity extends PluginName {
  readonly mark?: PluginMark;
}

/** The name the core carries as a source, where a plugin's name would stand. */
export const CORE_SOURCE_NAME = "Hercule";

/** Returns the name of the plugin `pluginId`, or the id itself when the plugin is not listed. */
export const namePlugin = (pluginId: string, plugins: ReadonlyArray<PluginName>): string =>
  plugins.find((plugin) => plugin.id === pluginId)?.displayName ?? pluginId;

/**
 * The colour a plugin gives its mark or a status icon, ready to draw:
 *
 * - `hue`: an angle on the colour wheel, which the client draws at the
 *   lightness and strength of its theme;
 * - `exact`: one hex code for light themes and one for dark themes.
 */
export type PluginColorDrawing =
  | { readonly _tag: "hue"; readonly hue: number }
  | { readonly _tag: "exact"; readonly light: string; readonly dark: string };

/**
 * Decides how to draw the colour a plugin declares with `hue` or `color`.
 * One `color` for every theme is drawn the same in light and dark themes.
 * Returns `undefined` when the plugin declares neither, so the client draws
 * its own default: the text colour for a mark, grey for a status icon.
 */
export const decidePluginColor = (declared: {
  readonly hue?: number;
  readonly color?: ExactColor;
}): PluginColorDrawing | undefined => {
  if (declared.hue !== undefined) return { _tag: "hue", hue: declared.hue };
  if (declared.color === undefined) return undefined;
  return typeof declared.color === "string"
    ? { _tag: "exact", light: declared.color, dark: declared.color }
    : { _tag: "exact", light: declared.color.light, dark: declared.color.dark };
};

/** What a client draws as a plugin's mark: the plugin's own paths, or the initial of its name. */
export type PluginMarkDrawing =
  | { readonly _tag: "paths"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "initial"; readonly initial: string };

/**
 * Decides what to draw as the mark of the plugin `pluginId`: the paths of
 * the mark it declares, or else the first letter of its name in upper case,
 * which the apps draw in a rounded square. A plugin `plugins` does not list
 * gets the first letter of its id.
 */
export const decidePluginMark = (
  pluginId: string,
  plugins: ReadonlyArray<PluginIdentity>,
): PluginMarkDrawing => {
  const mark = plugins.find((plugin) => plugin.id === pluginId)?.mark;
  if (mark !== undefined) return { _tag: "paths", paths: mark.paths };
  return { _tag: "initial", initial: namePlugin(pluginId, plugins).charAt(0).toUpperCase() };
};
