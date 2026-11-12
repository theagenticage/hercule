/**
 * What the Inbox's rail and its list head read from the counts: the saved
 * queries, pins and Browse sources the rail draws, the name of the list the
 * user is on, and the account a thing or a value belongs to.
 *
 * The scope is what the list is on: a saved query, or one Browse value.
 */
import type { EntityStatus, InboxCounts } from "@hercule/contract";
import { namePlugin, type PluginName } from "../intake";

/** A Browse value: one value of one Facet, of one source, in one account when the source has several. */
export interface InboxScopeValue {
  readonly source: string;
  readonly connectionId?: string;
  readonly key: string;
  readonly value: string;
}

/** What the Inbox list is on: a saved query, or a Browse value. */
export type InboxScope =
  | { readonly kind: "saved-query"; readonly id: string }
  | { readonly kind: "value"; readonly value: InboxScopeValue };

/** The icons of the core's saved queries. A plugin's saved query draws its plugin's mark instead. */
export type RailIconName = "clock" | "user" | "eye" | "agent" | "intake";

export interface RailSavedQuery {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  /** The core's icon, or the id of the plugin whose mark is drawn. Exactly one of the two. */
  readonly icon: RailIconName | { readonly pluginId: string };
  /** The digit that picks this entry, shown over the count under the pointer and on focus. */
  readonly shortcut?: string;
}

export interface RailPin extends InboxScopeValue {
  readonly label: string;
  readonly count: number;
  /** The account's label, given only when the pin's source has several accounts. */
  readonly accountLabel?: string;
}

export type RailHealth = "on-track" | "at-risk" | "off-track";

export interface RailFacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly health?: RailHealth;
}

export interface RailFacet {
  /** The account this facet is read in; absent when the source has one account. */
  readonly connectionId?: string;
  readonly key: string;
  /** The facet's plural name, shown as its small label: "Teams". */
  readonly plural: string;
  readonly values: ReadonlyArray<RailFacetValue>;
  /** How many more values exist than the ones sent. The search reaches them. */
  readonly more: number;
}

export interface RailAccount {
  readonly connectionId: string;
  readonly label: string;
  readonly count: number;
}

export interface RailSource {
  /** The source's plugin id. */
  readonly source: string;
  readonly name: string;
  readonly count: number;
  readonly folded: boolean;
  /** When the source stopped being readable, as the time to show ("08:40"). Absent while it reads. */
  readonly failingSince?: string;
  /** Listed only when more than one account holds things. */
  readonly accounts: ReadonlyArray<RailAccount>;
  /** Empty while the source is folded. */
  readonly facets: ReadonlyArray<RailFacet>;
}

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
 * Returns the label of the account a thing or a value belongs to, for a
 * source with the given `accounts`: the first account of `connectionIds`
 * that the source lists. Returns `undefined` when the source has one account
 * or none, because a label that tells nothing apart is only noise, and when
 * none of `connectionIds` is listed.
 */
export const findAccountLabel = (
  accounts: ReadonlyArray<{ readonly connectionId: string; readonly label: string }>,
  connectionIds: ReadonlyArray<string>,
): string | undefined =>
  accounts.length > 1
    ? accounts.find((account) => connectionIds.includes(account.connectionId))?.label
    : undefined;

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
  plugins: ReadonlyArray<PluginName>,
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
    const accountLabel = findAccountLabel(
      accounts,
      pin.connectionId === undefined ? [] : [pin.connectionId],
    );
    return {
      source: pin.source,
      key: pin.key,
      value: pin.value,
      label: pin.label,
      count: pin.count,
      ...(pin.connectionId === undefined ? {} : { connectionId: pin.connectionId }),
      ...(accountLabel === undefined ? {} : { accountLabel }),
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

/**
 * Returns the name of a scope for the list head and the search's scope token:
 * a saved query's name, else the label of the Browse value (a pin or a facet
 * value of the counts), else the value as it was sent.
 */
export const nameInboxScope = (scope: InboxScope, counts: InboxCounts): string => {
  if (scope.kind === "saved-query") {
    return counts.savedQueries.find((query) => query.id === scope.id)?.name ?? scope.id;
  }
  const { value } = scope;
  const pinned = counts.pins.find(
    (pin) => pin.source === value.source && pin.key === value.key && pin.value === value.value,
  );
  if (pinned !== undefined) return pinned.label;
  for (const source of counts.sources) {
    if (source.source !== value.source) continue;
    for (const facet of source.facets ?? []) {
      if (facet.key !== value.key) continue;
      const item = facet.values.find((each) => each.value === value.value);
      if (item !== undefined) return item.label;
    }
  }
  return value.value;
};
