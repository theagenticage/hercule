/**
 * What an Inbox with no card says. The page tells a controller that has never
 * been given a source (first run) from one whose sources have nothing for the
 * user right now (all clear).
 */
import type { Connection, Inbox, PluginDetail } from "@hercule/contract";
import { namePlugin } from "../intake";
import { parsePluginId } from "../plugin-id";

/** A source the page asks the user to connect: one plugin, for the side its cards will lie on. */
export interface SourceOffer {
  readonly pluginId: string;
  /** The plugin's display name, such as "GitHub". */
  readonly name: string;
  /** What the plugin's kind says it brings, such as "Reviews people ask of you". */
  readonly line: string;
  /** Lasting work lies under Ongoing, and small requests lie in Requests. */
  readonly side: "ongoing" | "requests";
}

/** What an Inbox with no card draws. */
export type EmptyInbox =
  | {
      readonly _tag: "first-run";
      /** One offer for each plugin and side, ordered by side and then by name. */
      readonly offers: readonly SourceOffer[];
    }
  | { readonly _tag: "all-clear" };

/**
 * Lists the offers of `plugins`: each plugin that declares a kind of card with
 * a `connect` line, once for each side its kinds lie on. A kind with no card
 * size is rich, and a context kind has no card, so it offers nothing. A kind
 * that declares no `connect` line offers nothing.
 */
export const listSourceOffers = (plugins: readonly PluginDetail[]): readonly SourceOffer[] => {
  const offers = new Map<string, SourceOffer>();
  for (const plugin of plugins) {
    for (const kind of plugin.entityKinds) {
      if (kind.pace === "context" || kind.connect === undefined) continue;
      const side = kind.card === "compact" ? "requests" : "ongoing";
      const key = `${plugin.id}:${side}`;
      if (!offers.has(key)) {
        offers.set(key, {
          pluginId: plugin.id,
          name: namePlugin(plugin.id, plugins),
          line: kind.connect,
          side,
        });
      }
    }
  }
  return [...offers.values()].sort(
    (a, b) => a.side.localeCompare(b.side, "en") || a.name.localeCompare(b.name, "en"),
  );
};

/**
 * Decides what an Inbox with no card draws, or returns `null` when it has
 * cards.
 *
 * - First run: no Connection belongs to a plugin that declares kinds of
 *   cards, so nothing could ever have arrived. The page asks for sources.
 * - All clear: a source is connected and has nothing for the user now.
 *
 * It tells the two apart by the Connections, not by what once was on the
 * page, because the controller keeps no record of cards that came and went.
 */
export const decideEmptyInbox = (
  inbox: Inbox,
  connections: readonly Connection[],
  plugins: readonly PluginDetail[],
): EmptyInbox | null => {
  if (inbox.cards.length > 0) return null;
  const sourcePluginIds = new Set(
    plugins.filter((plugin) => plugin.entityKinds.length > 0).map((plugin) => plugin.id),
  );
  const hasSource = connections.some((connection) => {
    const pluginId = parsePluginId(connection.type);
    return pluginId !== null && sourcePluginIds.has(pluginId);
  });
  return hasSource
    ? { _tag: "all-clear" }
    : { _tag: "first-run", offers: listSourceOffers(plugins) };
};
