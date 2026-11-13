/**
 * What the Inbox's rail and its list head read from the outline: the saved
 * queries, pins and Browse sources the rail draws, the name of the list the
 * user is on, and the account a thing or a value belongs to.
 *
 * The scope is what the list is on: a saved query, or one Browse value.
 */
import {
  CORE_SAVED_QUERY_IDS,
  type EntityStatus,
  type InboxBrowseValue,
  type InboxOutline,
} from "@hercule/contract";
import { namePlugin, type PluginName } from "../intake";

/** What the Inbox list is on: a saved query, or a Browse value. */
export type InboxScope =
  | { readonly kind: "saved-query"; readonly id: string }
  | { readonly kind: "value"; readonly value: InboxBrowseValue };

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

export interface RailPin extends InboxBrowseValue {
  /** The name drawn: a repository's own name, without its owner. */
  readonly label: string;
  /** The owner of a repository whose name another value of the same account shares. Drawn faint, before the name. */
  readonly owner?: string;
  /** The whole name, for the tooltip: "owner/repo" for a repository. */
  readonly title: string;
  readonly count: number;
  /** The account's label, given only when the pin's source has several accounts. */
  readonly accountLabel?: string;
}

export type RailHealth = "on-track" | "at-risk" | "off-track";

export interface RailFacetValue {
  readonly value: string;
  /** The name drawn: a repository's own name, without its owner. */
  readonly label: string;
  /** The owner of a repository whose name another value of the same account shares. Drawn faint, before the name. */
  readonly owner?: string;
  /** The whole name, for the tooltip: "owner/repo" for a repository. */
  readonly title: string;
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
  /** When a failing Connection of the source last changed, as the time to show ("08:40"). It is not when the failure began: the controller does not keep that. Absent while it reads. */
  readonly failingChangedAt?: string;
  /** Listed only when more than one account holds things. */
  readonly accounts: ReadonlyArray<RailAccount>;
  /** Empty while the source is folded. */
  readonly facets: ReadonlyArray<RailFacet>;
}

/** What the rail draws from the Inbox's outline: its lists, pins and Browse sources. */
export interface InboxRailContent {
  readonly savedQueries: ReadonlyArray<RailSavedQuery>;
  readonly pins: ReadonlyArray<RailPin>;
  readonly sources: ReadonlyArray<RailSource>;
}

/** The icons of the core's saved queries, by their ids. Any other saved query draws its plugin's mark. */
const CORE_ICONS: Readonly<Record<string, RailIconName>> = {
  [CORE_SAVED_QUERY_IDS.waits]: "clock",
  [CORE_SAVED_QUERY_IDS.mine]: "user",
  [CORE_SAVED_QUERY_IDS.updates]: "eye",
  [CORE_SAVED_QUERY_IDS.held]: "agent",
  [CORE_SAVED_QUERY_IDS.everything]: "intake",
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

/** The key of the facet whose values are repositories, written "owner/name". */
const REPOSITORY_KEY = "repo";

interface DrawnName {
  readonly label: string;
  readonly owner?: string;
  readonly title: string;
}

/**
 * Returns what the rail draws for the names of the values of one facet in one
 * account, in the order given.
 *
 * - A repository (`key` is `repo`, the name is `owner/name`) is drawn as its own
 *   name. Its owner comes along only when another name in `names` is the same
 *   repository name under another owner, because then the name alone is
 *   ambiguous.
 * - Any other name is drawn whole, with no owner.
 * - `title` is always the whole name, for the tooltip.
 */
const describeValueNames = (
  key: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<DrawnName> => {
  if (key !== REPOSITORY_KEY) return names.map((name) => ({ label: name, title: name }));
  const split = names.map((name) => {
    const slash = name.indexOf("/");
    return slash < 0
      ? { owner: undefined, own: name }
      : { owner: name.slice(0, slash), own: name.slice(slash + 1) };
  });
  const times = new Map<string, number>();
  for (const { own } of split) times.set(own, (times.get(own) ?? 0) + 1);
  return split.map(({ owner, own }, index) => ({
    label: own,
    title: names[index]!,
    ...(owner !== undefined && (times.get(own) ?? 0) > 1 ? { owner } : {}),
  }));
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
 * Returns the rail's saved queries, pins and Browse sources for `outline`.
 *
 * - A core saved query has the icon of its id, a plugin's has its plugin's
 *   mark, and the first seven have their digit.
 * - A pin names its account when its source has more than one.
 * - A repository is named by its own name, with its owner only when two names
 *   of one account share it (see `describeValueNames`).
 * - A source names itself with its plugin's name, and carries the time a failing Connection
 *   last changed when `outline.failing` lists it. `formatTime` writes
 *   that time for the reader ("08:40").
 */
export function describeInboxRail(
  outline: InboxOutline,
  plugins: ReadonlyArray<PluginName>,
  formatTime: (iso: string) => string,
): InboxRailContent {
  const savedQueries = outline.savedQueries.map((query, index): RailSavedQuery => ({
    id: query.id,
    name: query.name,
    count: query.count,
    icon:
      query.source === undefined ? (CORE_ICONS[query.id] ?? "intake") : { pluginId: query.source },
    ...(index < KEYED_SAVED_QUERIES ? { shortcut: String(index + 1) } : {}),
  }));
  // Pins are named in groups of one source, account and facet, as the values they came from are.
  const buildPinGroupKey = (pin: InboxOutline["pins"][number]): string =>
    JSON.stringify([pin.source, pin.connectionId ?? null, pin.key]);
  const pinNames = new Map<InboxOutline["pins"][number], DrawnName>();
  for (const group of new Set(outline.pins.map(buildPinGroupKey))) {
    const members = outline.pins.filter((pin) => buildPinGroupKey(pin) === group);
    const first = members[0]!;
    const facet = outline.sources
      .find((source) => source.source === first.source)
      ?.facets?.find(
        (facet) => facet.key === first.key && facet.connectionId === first.connectionId,
      );
    const labels = [
      ...new Set([
        ...members.map((pin) => pin.label),
        ...(facet?.values.map((value) => value.label) ?? []),
      ]),
    ];
    const names = describeValueNames(first.key, labels);
    const namesByLabel = new Map(labels.map((label, index) => [label, names[index]!]));
    members.forEach((pin) => pinNames.set(pin, namesByLabel.get(pin.label)!));
  }
  const pins = outline.pins.map((pin): RailPin => {
    const drawn = pinNames.get(pin)!;
    const accounts = outline.sources.find((source) => source.source === pin.source)?.accounts ?? [];
    const accountLabel = findAccountLabel(
      accounts,
      pin.connectionId === undefined ? [] : [pin.connectionId],
    );
    return {
      source: pin.source,
      key: pin.key,
      value: pin.value,
      label: drawn.label,
      title: drawn.title,
      ...(drawn.owner === undefined ? {} : { owner: drawn.owner }),
      count: pin.count,
      ...(pin.connectionId === undefined ? {} : { connectionId: pin.connectionId }),
      ...(accountLabel === undefined ? {} : { accountLabel }),
    };
  });
  const sources = outline.sources.map((source): RailSource => {
    const failing = outline.failing.find((each) => each.source === source.source);
    return {
      source: source.source,
      name: namePlugin(source.source, plugins),
      count: source.count,
      folded: source.folded,
      ...(failing === undefined ? {} : { failingChangedAt: formatTime(failing.updatedAt) }),
      accounts: source.accounts,
      facets: (source.facets ?? []).map((facet) => {
        const names = describeValueNames(
          facet.key,
          facet.values.map((item) => item.label),
        );
        return {
          key: facet.key,
          plural: facet.plural,
          more: facet.more,
          ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
          values: facet.values.map((item, index) => {
            const health = readHealth(item.health);
            const drawn = names[index]!;
            return {
              value: item.value,
              label: drawn.label,
              title: drawn.title,
              ...(drawn.owner === undefined ? {} : { owner: drawn.owner }),
              count: item.count,
              ...(health === undefined ? {} : { health }),
            };
          }),
        };
      }),
    };
  });
  return { savedQueries, pins, sources };
}

/**
 * Returns the name of a scope for the list head and the search's scope token:
 * a saved query's name, else the label of the Browse value (a pin or a facet
 * value of the outline), else the value as it was sent.
 */
export const nameInboxScope = (scope: InboxScope, outline: InboxOutline): string => {
  if (scope.kind === "saved-query") {
    return outline.savedQueries.find((query) => query.id === scope.id)?.name ?? scope.id;
  }
  const { value } = scope;
  const pinned = outline.pins.find(
    (pin) => pin.source === value.source && pin.key === value.key && pin.value === value.value,
  );
  if (pinned !== undefined) return pinned.label;
  for (const source of outline.sources) {
    if (source.source !== value.source) continue;
    for (const facet of source.facets ?? []) {
      if (facet.key !== value.key) continue;
      const item = facet.values.find((each) => each.value === value.value);
      if (item !== undefined) return item.label;
    }
  }
  return value.value;
};
