import { useState, type JSX, type KeyboardEvent } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { InboxBrowseValue } from "@hercule/contract";
import type {
  InboxScope,
  RailAccount,
  RailFacet,
  RailFacetValue,
  RailHealth,
  RailPin,
  RailSavedQuery,
  RailSource,
} from "@hercule/client-core/inbox";
import { AgentIcon } from "../../icons/agent";
import { AlertIcon } from "../../icons/alert";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ClockIcon } from "../../icons/clock";
import { ConnectionsIcon } from "../../icons/connections";
import { EyeIcon } from "../../icons/eye";
import { IntakeIcon } from "../../icons/intake";
import { UserIcon } from "../../icons/user";
import { PluginMark } from "../../marks/plugin-mark";
import "./inbox-rail.css";

/** The facet a "Search the other N" row stands for. */
export interface RailFacetScope {
  readonly source: string;
  readonly connectionId?: string;
  readonly key: string;
}

export interface InboxRailProps {
  readonly savedQueries: ReadonlyArray<RailSavedQuery>;
  readonly pins: ReadonlyArray<RailPin>;
  readonly sources: ReadonlyArray<RailSource>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** What the list is on. Null when the user is searching: nothing in the rail is drawn on then. */
  readonly current: InboxScope | null;
  /** While counts load, each is drawn as a still bar. */
  readonly loading: boolean;
  /** Called when the user picks an entry. The caller moves the focus to the list. */
  readonly onPick: (entry: InboxScope) => void;
  readonly onToggleFold: (source: string) => void;
  /** Pins the value, or unpins it when it is pinned. */
  readonly onTogglePin: (value: InboxBrowseValue) => void;
  readonly onSearchMore: (facet: RailFacetScope) => void;
}

/** How many values a facet shows before "N more". */
const VALUES_SHOWN = 6;

const HEALTH_WORDS: Readonly<Record<RailHealth, string>> = {
  "on-track": "On track",
  "at-risk": "At risk",
  "off-track": "Off track",
};

const valueKey = (value: InboxBrowseValue): string =>
  JSON.stringify([value.source, value.connectionId ?? null, value.key, value.value]);

const facetKey = (source: string, facet: RailFacet): string =>
  JSON.stringify([source, facet.connectionId ?? null, facet.key]);

const isCurrentValue = (current: InboxScope | null, value: InboxBrowseValue): boolean =>
  current?.kind === "value" && valueKey(current.value) === valueKey(value);

/** Returns the facets of `source` that belong under `account`, or all of them when it has no account level. */
const facetsUnder = (source: RailSource, account: RailAccount | null): ReadonlyArray<RailFacet> =>
  source.facets.filter((facet) => account === null || facet.connectionId === account.connectionId);

/** Returns the values of `facet` the rail shows: six, or every one sent when the facet is opened. */
const visibleValues = (facet: RailFacet, isOpened: boolean): ReadonlyArray<RailFacetValue> =>
  isOpened ? facet.values : facet.values.slice(0, VALUES_SHOWN);

interface StopCandidate {
  readonly id: string;
  readonly isCurrent: boolean;
}

/**
 * Lists every focusable entry of the rail in the order it is drawn: the ids the
 * rail's one Tab stop is chosen from. The star of a value follows its row.
 */
function listStopCandidates(
  props: InboxRailProps,
  openedFacets: ReadonlySet<string>,
): ReadonlyArray<StopCandidate> {
  const candidates: StopCandidate[] = [];
  for (const query of props.savedQueries) {
    candidates.push({
      id: `saved:${query.id}`,
      isCurrent: props.current?.kind === "saved-query" && props.current.id === query.id,
    });
  }
  for (const pin of props.pins) {
    const isCurrent = isCurrentValue(props.current, pin);
    candidates.push({ id: `pin:${valueKey(pin)}`, isCurrent });
    candidates.push({ id: `star:pin:${valueKey(pin)}`, isCurrent: false });
  }
  for (const source of props.sources) {
    candidates.push({ id: `fold:${source.source}`, isCurrent: false });
    const levels = source.accounts.length > 1 ? source.accounts : [null];
    for (const account of levels) {
      for (const facet of facetsUnder(source, account)) {
        const isOpened = openedFacets.has(facetKey(source.source, facet));
        for (const item of visibleValues(facet, isOpened)) {
          const value = valueOf(source.source, facet, item);
          candidates.push({
            id: `value:${valueKey(value)}`,
            isCurrent: isCurrentValue(props.current, value),
          });
          candidates.push({ id: `star:value:${valueKey(value)}`, isCurrent: false });
        }
        if (facet.values.length > VALUES_SHOWN) {
          candidates.push({ id: `more:${facetKey(source.source, facet)}`, isCurrent: false });
        }
        if (facet.more > 0 && (isOpened || facet.values.length <= VALUES_SHOWN)) {
          candidates.push({ id: `search:${facetKey(source.source, facet)}`, isCurrent: false });
        }
      }
    }
  }
  return candidates;
}

const valueOf = (source: string, facet: RailFacet, item: RailFacetValue): InboxBrowseValue => ({
  source,
  key: facet.key,
  value: item.value,
  ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
});

/**
 * Renders the Inbox's rail: the saved queries, the user's pins, and Browse,
 * each source with its accounts and Facet values. It reads nothing: the caller
 * passes every value and handles every pick.
 *
 * The rail is one Tab stop (the entry the list is on, else the one last
 * focused, else the first). Arrow keys, Home and End move inside it, the right
 * and left arrows unfold and fold a source, and P pins or unpins the focused
 * value. No other single key does anything here.
 */
export function InboxRail(props: InboxRailProps): JSX.Element {
  const { savedQueries, pins, sources, plugins, current, loading } = props;
  const [openedFacets, setOpenedFacets] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const candidates = listStopCandidates(props, openedFacets);
  const stopId =
    candidates.find((candidate) => candidate.id === focusedId)?.id ??
    candidates.find((candidate) => candidate.isCurrent)?.id ??
    candidates[0]?.id;

  const toggleOpened = (key: string): void => {
    setOpenedFacets((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-rail-item]"));
    const at = items.indexOf(active);
    if (at < 0) return;
    const fold = active.hasAttribute("data-rail-fold") ? active : null;
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = items[Math.min(items.length - 1, at + 1)];
        break;
      case "ArrowUp":
        target = items[Math.max(0, at - 1)];
        break;
      case "Home":
        target = items[0];
        break;
      case "End":
        target = items[items.length - 1];
        break;
      case "ArrowRight":
        if (fold?.getAttribute("aria-expanded") === "false") fold.click();
        else return;
        event.preventDefault();
        return;
      case "ArrowLeft":
        if (fold?.getAttribute("aria-expanded") === "true") fold.click();
        else return;
        event.preventDefault();
        return;
      case "p":
      case "P":
        if (event.shiftKey) return;
        {
          const star = active
            .closest("[data-rail-pair]")
            ?.querySelector<HTMLElement>("[data-rail-star]");
          if (star === null || star === undefined) return;
          star.click();
        }
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    target?.focus();
  };

  const countOf = (count: number): JSX.Element => (
    <span className="ib-rail-count">
      {loading ? <span className="ib-rail-count-skeleton" /> : count > 0 ? count : null}
    </span>
  );

  const itemProps = (id: string) => ({
    "data-rail-item": id,
    tabIndex: id === stopId ? 0 : -1,
    onFocus: () => {
      setFocusedId(id);
    },
  });

  const star = (value: InboxBrowseValue, name: string, id: string): JSX.Element => {
    const isPinned = pins.some((pin) => valueKey(pin) === valueKey(value));
    return (
      <button
        type="button"
        className="ib-rail-star"
        data-rail-star=""
        {...itemProps(id)}
        title={isPinned ? "Unpin from the rail (P)" : "Pin to the rail (P)"}
        aria-label={`${isPinned ? "Unpin" : "Pin"} ${name}`}
        aria-pressed={isPinned}
        onClick={() => {
          props.onTogglePin(value);
        }}
      >
        <StarGlyph />
      </button>
    );
  };

  const valueRow = (value: InboxBrowseValue, label: string, item: RailFacetValue): JSX.Element => {
    const id = `value:${valueKey(value)}`;
    const isOn = isCurrentValue(current, value);
    const isEmpty = item.count === 0 && !loading;
    const health = item.health;
    return (
      <div className="ib-rail-pair" data-rail-pair="" key={id}>
        <button
          type="button"
          className="ib-rail-row ib-rail-value"
          data-on={isOn || undefined}
          data-empty={isEmpty || undefined}
          aria-current={isOn ? "true" : undefined}
          title={isEmpty ? "Nothing of yours here yet" : undefined}
          {...itemProps(id)}
          onClick={() => {
            props.onPick({ kind: "value", value });
          }}
        >
          <span className="ib-rail-icon">
            {health === undefined ? null : <HealthGlyph health={health} />}
          </span>
          <span className="ib-rail-name">{label}</span>
          {countOf(item.count)}
        </button>
        {star(value, label, `star:${id}`)}
      </div>
    );
  };

  const facetBlock = (source: RailSource, facet: RailFacet): JSX.Element | null => {
    if (facet.values.length === 0) return null;
    const key = facetKey(source.source, facet);
    const isOpened = openedFacets.has(key);
    return (
      <div key={key} role="group" aria-label={facet.plural}>
        <p className="ib-rail-facet" aria-hidden="true">
          {facet.plural}
        </p>
        {visibleValues(facet, isOpened).map((item) =>
          valueRow(valueOf(source.source, facet, item), item.label, item),
        )}
        {facet.values.length > VALUES_SHOWN ? (
          <button
            type="button"
            className="ib-rail-more"
            {...itemProps(`more:${key}`)}
            aria-expanded={isOpened}
            onClick={() => {
              toggleOpened(key);
            }}
          >
            {isOpened ? "Show fewer" : `${String(facet.values.length - VALUES_SHOWN)} more`}
          </button>
        ) : null}
        {facet.more > 0 && (isOpened || facet.values.length <= VALUES_SHOWN) ? (
          <button
            type="button"
            className="ib-rail-more"
            {...itemProps(`search:${key}`)}
            onClick={() => {
              props.onSearchMore({
                source: source.source,
                key: facet.key,
                ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
              });
            }}
          >
            {`Search the other ${String(facet.more)}`}
          </button>
        ) : null}
      </div>
    );
  };

  const sourceBlock = (source: RailSource): JSX.Element => {
    const warning =
      source.failingChangedAt === undefined
        ? null
        : `Can't be read; last changed ${source.failingChangedAt}`;
    const hasAccounts = source.accounts.length > 1;
    return (
      <div className="ib-rail-source" key={source.source}>
        <button
          type="button"
          className="ib-rail-row ib-rail-fold"
          data-rail-fold=""
          {...itemProps(`fold:${source.source}`)}
          aria-expanded={!source.folded}
          data-failing={warning === null ? undefined : ""}
          onClick={() => {
            props.onToggleFold(source.source);
          }}
        >
          <span className="ib-rail-icon">
            <PluginMark pluginId={source.source} plugins={plugins} size={16} />
            <span className="ib-rail-chevron" data-open={!source.folded || undefined}>
              <ChevronRightIcon size={12} />
            </span>
          </span>
          <span className="ib-rail-name">{source.name}</span>
          {warning === null ? null : (
            <span className="ib-rail-warning" role="img" aria-label={warning} title={warning}>
              <AlertIcon size={14} />
            </span>
          )}
          {countOf(source.count)}
        </button>
        {source.folded ? null : (
          <div className="ib-rail-source-body">
            {hasAccounts
              ? source.accounts.map((account) => (
                  <div key={account.connectionId}>
                    <p className="ib-rail-account">
                      <span className="ib-rail-icon">
                        <ConnectionsIcon size={14} />
                      </span>
                      <span className="ib-rail-name">{account.label}</span>
                      {countOf(account.count)}
                    </p>
                    {facetsUnder(source, account).map((facet) => facetBlock(source, facet))}
                  </div>
                ))
              : facetsUnder(source, null).map((facet) => facetBlock(source, facet))}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav className="ib-rail" aria-label="Inbox lists" onKeyDown={handleKeyDown}>
      <div className="ib-rail-group">
        {savedQueries.map((query) => {
          const isOn = current?.kind === "saved-query" && current.id === query.id;
          return (
            <button
              type="button"
              key={query.id}
              className="ib-rail-row"
              data-on={isOn || undefined}
              aria-current={isOn ? "true" : undefined}
              aria-keyshortcuts={query.shortcut}
              {...itemProps(`saved:${query.id}`)}
              onClick={() => {
                props.onPick({ kind: "saved-query", id: query.id });
              }}
            >
              <span className="ib-rail-icon">
                <SavedQueryIcon icon={query.icon} plugins={plugins} />
              </span>
              <span className="ib-rail-name">{query.name}</span>
              {countOf(query.count)}
              {query.shortcut === undefined ? null : (
                <kbd className="ib-rail-key" aria-hidden="true">
                  {query.shortcut}
                </kbd>
              )}
            </button>
          );
        })}
      </div>

      {pins.length === 0 ? null : (
        <>
          <h3 className="ib-rail-heading">Pinned</h3>
          <div className="ib-rail-group">
            {pins.map((pin) => {
              const id = `pin:${valueKey(pin)}`;
              const isOn = isCurrentValue(current, pin);
              return (
                <div className="ib-rail-pair" data-rail-pair="" key={id}>
                  <button
                    type="button"
                    className="ib-rail-row"
                    data-on={isOn || undefined}
                    aria-current={isOn ? "true" : undefined}
                    {...itemProps(id)}
                    onClick={() => {
                      props.onPick({ kind: "value", value: pin });
                    }}
                  >
                    <span className="ib-rail-icon">
                      <PluginMark pluginId={pin.source} plugins={plugins} size={16} />
                    </span>
                    <span className="ib-rail-name">
                      {pin.label}
                      {pin.accountLabel === undefined ? null : (
                        <>
                          {" "}
                          <span className="ib-rail-account-suffix">{`· ${pin.accountLabel}`}</span>
                        </>
                      )}
                    </span>
                    {countOf(pin.count)}
                  </button>
                  {star(pin, pin.label, `star:${id}`)}
                </div>
              );
            })}
          </div>
        </>
      )}

      {sources.some((source) => source.count > 0) ? (
        <h3 className="ib-rail-heading">Browse</h3>
      ) : null}
      {sources.map(sourceBlock)}
    </nav>
  );
}

function SavedQueryIcon({
  icon,
  plugins,
}: {
  readonly icon: RailSavedQuery["icon"];
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  if (typeof icon === "object")
    return <PluginMark pluginId={icon.pluginId} plugins={plugins} size={16} />;
  switch (icon) {
    case "clock":
      return <ClockIcon />;
    case "user":
      return <UserIcon />;
    case "eye":
      return <EyeIcon />;
    case "agent":
      return <AgentIcon />;
    case "intake":
      return <IntakeIcon />;
  }
}

/** Draws the star that pins a value: an outline, filled by the stylesheet when the value is pinned. */
function StarGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" />
    </svg>
  );
}

const HEALTH_SHAPES: Readonly<Record<RailHealth, JSX.Element>> = {
  "on-track": (
    <>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M4 6.1l1.4 1.4 2.6-2.8" />
    </>
  ),
  "at-risk": (
    <>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M6 3.7v2.6" />
      <circle cx="6" cy="8.3" r=".25" fill="currentColor" />
    </>
  ),
  "off-track": (
    <>
      <circle cx="6" cy="6" r="4.5" />
      <path d="M4.3 4.3l3.4 3.4M7.7 4.3 4.3 7.7" />
    </>
  ),
};

/** Draws a project's health at 12px: a check, a mark or a cross in a ring, with its word as the tooltip. */
function HealthGlyph({ health }: { readonly health: RailHealth }): JSX.Element {
  return (
    <span className="ib-rail-health" data-health={health} title={HEALTH_WORDS[health]}>
      <svg
        viewBox="0 0 12 12"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={HEALTH_WORDS[health]}
      >
        {HEALTH_SHAPES[health]}
      </svg>
    </span>
  );
}
