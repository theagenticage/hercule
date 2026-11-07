/**
 * The words around a place's surface on the wide side: what it is part of,
 * and whether its rows repeat its mark.
 */
import { namePlugin, type PluginName } from "../intake";
import { describeLockedRow } from "../desk/relation-rows";
import type { SurfaceHead } from "./inbox-place";

/**
 * Returns the name a surface goes by where a line points at it, such as "Also
 * in Pricing rules": a place's title, a source's plugin name, or the plain
 * title of a status. A place the user cannot open is worded as a locked row.
 */
export const nameSurface = (head: SurfaceHead, plugins: readonly PluginName[]): string => {
  if (head._tag === "source") return namePlugin(head.pluginId, plugins);
  if (head._tag === "plain") return head.title;
  return head.row.isLocked
    ? describeLockedRow(head.row, namePlugin(head.row.pluginId, plugins))
    : head.row.title;
};

/**
 * Returns what the place of `head` is itself part of, each place once,
 * nearest first, as the line under its name reads: "A checkout that never
 * drops a basket", "Shop". A place no Connection can read says "A Linear
 * initiative you cannot open". A head that is not a place is part of nothing.
 */
export const listSurfaceAboveWords = (
  head: SurfaceHead,
  plugins: readonly PluginName[],
): readonly string[] =>
  head._tag === "place"
    ? head.above.map((row) =>
        row.isLocked ? describeLockedRow(row, namePlugin(row.pluginId, plugins)) : row.title,
      )
    : [];

/**
 * Checks whether the head already shows the mark of `pluginId`, so a row on
 * that surface leaves its own out. A place or a source of that plugin shows
 * it. A place the user cannot open shows a lock, and a status or "No project"
 * shows nothing, so a row there keeps its mark.
 */
export const isMarkShownByHead = (head: SurfaceHead, pluginId: string): boolean => {
  if (head._tag === "source") return head.pluginId === pluginId;
  return head._tag === "place" && !head.row.isLocked && head.row.pluginId === pluginId;
};
