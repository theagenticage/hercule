import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import type { EntityStatus, InboxCounts } from "@hercule/contract";
import type { RailHealth, RailIconName, RailPin, RailSavedQuery, RailSource } from "./inbox-rail";

/** What the rail draws from the Inbox's counts: its lists, pins and Browse sources. */
export interface InboxRailContent {
  readonly savedQueries: ReadonlyArray<RailSavedQuery>;
  readonly pins: ReadonlyArray<RailPin>;
  readonly sources: ReadonlyArray<RailSource>;
}

/** The icons of the core's saved queries, by their ids. Any other saved query draws its plugin's mark. */
const CORE_ICONS: Readonly<Record<string, RailIconName>> = {
  waits: "clock",
  mine: "user",
  updates: "eye",
  "with-hercule": "agent",
  everything: "intake",
};

/** How many saved queries have a digit key: 1 to 7. */
const KEYED_SAVED_QUERIES = 7;

/** Returns the health a context record's status reads as, or `undefined` for a status that is not a health. */
const readHealth = (status: EntityStatus | undefined): RailHealth | undefined => {
  if (status === undefined) return undefined;
  if (status.tone === "good") return "on-track";
  if (status.tone === "bad") return "off-track";
  if (status.tone === "attention") return "at-risk";
  return undefined;
};

/**
 * Returns the rail's saved queries, pins and Browse sources for `counts`.
 *
 * - A core saved query has the icon of its id, a plugin's has its plugin's
 *   mark, and the first seven have their digit.
 * - A pin names its account when its source has more than one.
 * - A source names itself with its plugin's name, and carries the time it
 *   stopped being readable when `counts.failing` lists it. `formatTime` writes
 *   that time for the reader ("08:40").
 */
export function describeInboxRail(
  counts: InboxCounts,
  plugins: ReadonlyArray<PluginIdentity>,
  formatTime: (iso: string) => string,
): InboxRailContent {
  const savedQueries = counts.savedQueries.map((query, index): RailSavedQuery => ({
    id: query.id,
    name: query.name,
    count: query.count,
    icon:
      query.source === undefined ? (CORE_ICONS[query.id] ?? "intake") : { pluginId: query.source },
    ...(index < KEYED_SAVED_QUERIES ? { shortcut: String(index + 1) } : {}),
  }));
  const pins = counts.pins.map((pin): RailPin => {
    const accounts = counts.sources.find((source) => source.source === pin.source)?.accounts ?? [];
    const account =
      accounts.length > 1
        ? accounts.find((each) => each.connectionId === pin.connectionId)
        : undefined;
    return {
      source: pin.source,
      key: pin.key,
      value: pin.value,
      label: pin.label,
      count: pin.count,
      ...(pin.connectionId === undefined ? {} : { connectionId: pin.connectionId }),
      ...(account === undefined ? {} : { accountLabel: account.label }),
    };
  });
  const sources = counts.sources.map((source): RailSource => {
    const failing = counts.failing.find((each) => each.source === source.source);
    return {
      source: source.source,
      name: namePlugin(source.source, plugins),
      count: source.count,
      folded: source.folded,
      ...(failing === undefined ? {} : { failingSince: formatTime(failing.since) }),
      accounts: source.accounts,
      facets: (source.facets ?? []).map((facet) => ({
        key: facet.key,
        plural: facet.plural,
        more: facet.more,
        ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
        values: facet.values.map((item) => {
          const health = readHealth(item.health);
          return {
            value: item.value,
            label: item.label,
            count: item.count,
            ...(health === undefined ? {} : { health }),
          };
        }),
      })),
    };
  });
  return { savedQueries, pins, sources };
}
