import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient, PluginIdentity } from "@hercule/client-core";
import { listLinkableRows } from "@hercule/client-core/desk";
import {
  decideAddList,
  listAddSources,
  type AddRow,
  type AddSource,
} from "@hercule/client-core/work";
import { pluginsQuery } from "../../app/queries";
import { LinkIcon } from "../../icons/link";
import { PluginMark } from "../../marks";
import { ViewSwitch } from "../view-switch";
import { useEntitySearch } from "./use-entity-search";
import "./link-search.css";

const PLACEHOLDER = "Search by title or number";

/**
 * How tall the rows of the search are: `compact` (24px) for the Inbox's open
 * card, and `tall` (32px) for the details pane, whose other rows are that tall.
 */
export type LinkSearchSize = "compact" | "tall";

/**
 * Renders the search of one source, and the rows that can be linked from what
 * it finds. It runs Work's Add search (`useEntitySearch`, the same words for
 * each outcome): a source is chosen on a tab, and Return links the first row.
 */
function SourceSearch({
  client,
  size,
  sources,
  names,
  plugins,
  initialSource,
  excludedRefs,
  onPick,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly size: LinkSearchSize;
  readonly sources: readonly AddSource[];
  readonly names: ReadonlyMap<string, string>;
  readonly plugins: readonly PluginIdentity[];
  readonly initialSource: string;
  readonly excludedRefs: readonly string[];
  readonly onPick: (row: AddRow) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState(initialSource);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const search = useEntitySearch({
    client,
    sources,
    tab,
    scopeRef: "",
    isOffline: false,
    onSourceMoved: setTab,
  });
  const { reply } = search;
  const list = decideAddList({
    sourceName: names.get(reply?.source ?? tab) ?? tab,
    names,
    text: search.searchedText,
    isLink: search.isLink,
    isOffline: false,
    scope: undefined,
    search: search.state,
  });
  const rows = list.kind === "results" ? listLinkableRows(list.rows, excludedRefs) : [];
  const note =
    list.kind === "searching" || list.kind === "message"
      ? list.text
      : list.kind === "results" && rows.length === 0
        ? "Everything found is already linked."
        : undefined;

  const submit = (): void => {
    // The list on screen may be for older words, so Return searches the new ones first.
    if (search.searchTypedWords()) return;
    const first = rows[0];
    if (first !== undefined) onPick(first);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

  return (
    <div className="link-search-find" onKeyDown={closeOnEscape}>
      {sources.length > 1 && (
        <ViewSwitch
          className="seg link-search-sources"
          label="Source"
          choices={sources.map((source) => ({
            view: source.id,
            label: source.name,
            mark: <PluginMark pluginId={source.id} plugins={plugins} size={14} />,
          }))}
          view={tab}
          onPick={(id) => {
            setTab(id);
            search.searchIn(id, "");
            inputRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          className="link-search-input"
          value={search.text}
          placeholder={PLACEHOLDER}
          aria-label="Link something"
          autoComplete="off"
          onChange={(event) => {
            search.type(event.target.value);
          }}
        />
      </form>
      {note !== undefined && (
        <p className="link-search-note" aria-live="polite">
          {note}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="link-search-found">
          {rows.map((row) => (
            <li key={row.ref}>
              <button
                type="button"
                className="link-search-go"
                onClick={() => {
                  onPick(row);
                }}
              >
                <span className="link-search-mark">
                  <PluginMark
                    pluginId={reply?.source ?? tab}
                    plugins={plugins}
                    size={size === "tall" ? 13 : 14}
                  />
                </span>
                <span className="link-search-title">{row.title}</span>
                <small>{row.identifier}</small>
                {row.state !== "" && <span className="link-search-state">{row.state}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders the way to link something to the open thing, at the foot of its
 * Linked section: a "Link something" button that opens a search of the
 * sources, which reads a pasted link too. Choosing a row calls `onPick` with
 * it and closes the search.
 *
 * - `excludedRefs` are the refs the search never offers: what is linked
 *   already, and the thing itself when it has a ref.
 * - `size` is how tall its rows are (`LinkSearchSize`).
 * - `ownPluginId` is the plugin that owns the open thing, if any. The search
 *   starts on another source when there is one, because a link between two
 *   sources is the usual one: a ticket and its pull request.
 *
 * The plugins are read only once the search opens.
 */
export function LinkSearch({
  client,
  size,
  excludedRefs,
  ownPluginId,
  onPick,
}: {
  readonly client: HerculeClient;
  readonly size: LinkSearchSize;
  readonly excludedRefs: readonly string[];
  readonly ownPluginId?: string;
  readonly onPick: (row: AddRow) => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className={size === "tall" ? "link-search is-tall" : "link-search"}>
      {isOpen ? (
        <OpenSearch
          client={client}
          size={size}
          excludedRefs={excludedRefs}
          ownPluginId={ownPluginId}
          onPick={(row) => {
            setIsOpen(false);
            onPick(row);
          }}
          onClose={() => {
            setIsOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="link-search-open"
          onClick={() => {
            setIsOpen(true);
          }}
        >
          <LinkIcon size={size === "tall" ? 13 : 12} />
          Link something
        </button>
      )}
    </div>
  );
}

/** Reads the plugins and draws the search on the first source that can be searched, or says there is none. */
function OpenSearch({
  client,
  size,
  excludedRefs,
  ownPluginId,
  onPick,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly size: LinkSearchSize;
  readonly excludedRefs: readonly string[];
  readonly ownPluginId: string | undefined;
  readonly onPick: (row: AddRow) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const sources = listAddSources(plugins);
  const start = sources.find((source) => source.id !== ownPluginId) ?? sources[0];
  if (start === undefined) {
    return <p className="link-search-note">No source can be searched. Add a Connection first.</p>;
  }
  return (
    <SourceSearch
      client={client}
      size={size}
      sources={sources}
      names={new Map(plugins.map((plugin) => [plugin.id, plugin.displayName]))}
      plugins={plugins}
      initialSource={start.id}
      excludedRefs={excludedRefs}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
