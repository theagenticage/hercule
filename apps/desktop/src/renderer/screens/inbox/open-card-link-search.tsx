import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { listLinkableRows } from "@hercule/client-core/inbox";
import {
  buildEntitySearch,
  decideAddList,
  isPastedLink,
  listAddSources,
  type AddRow,
  type AddSource,
  type SearchState,
} from "@hercule/client-core/work";
import type { EntityLink, EntitySearchQuery, EntitySearchReply } from "@hercule/contract";
import { entitySearchQuery, pluginsQuery } from "../../app/queries";
import { LinkIcon } from "../../icons/link";
import { PluginMark } from "../../marks";
import { ViewSwitch } from "../view-switch";

/** How long typing must stop before a search is sent, in milliseconds. The Add to Work sheet waits as long. */
const TYPING_PAUSE_MS = 180;

const PLACEHOLDER = "Search by title or number";

/**
 * Renders the search of one source, and the rows that can be linked from what
 * it finds. It is Work's Add search (`externalEntity.search`, the same words
 * for each outcome): a source is chosen on a tab, typing waits for a pause, a
 * pasted link moves the tab to the source that answered it, and Return links
 * the first row.
 */
function SourceLinkSearch({
  client,
  sources,
  names,
  plugins,
  initialSource,
  selfRef,
  links,
  onPick,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly sources: readonly AddSource[];
  readonly names: ReadonlyMap<string, string>;
  readonly plugins: Parameters<typeof PluginMark>[0]["plugins"];
  readonly initialSource: string;
  readonly selfRef: string;
  readonly links: readonly EntityLink[];
  readonly onPick: (row: AddRow) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState(initialSource);
  const [text, setText] = useState("");
  // The words and source last sent, so a pasted link that moves the tab does not ask again.
  const [search, setSearch] = useState<EntitySearchQuery | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // A search waits for typing to stop. Clearing the field does not wait.
  useEffect(() => {
    if (text.trim() === (search?.text ?? "")) return;
    const timer = setTimeout(() => {
      setSearch(buildEntitySearch(text, tab, ""));
    }, TYPING_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, search, tab]);

  const read = useQuery({
    ...entitySearchQuery(client, search ?? undefined),
    enabled: search !== null,
  });
  const reply = read.data;

  // An answer that says the link is from another source moves the tab there.
  const [lastReply, setLastReply] = useState<EntitySearchReply | undefined>(undefined);
  if (reply !== undefined && reply !== lastReply) {
    setLastReply(reply);
    if (reply.source !== tab && sources.some((source) => source.id === reply.source)) {
      setTab(reply.source);
    }
  }

  const isLink = search !== null && isPastedLink(search.text);
  const searchState: SearchState =
    search === null
      ? { status: "idle" }
      : reply !== undefined
        ? { status: "answered", reply }
        : read.error !== null
          ? { status: "failed", reason: readErrorMessage(read.error) }
          : { status: "pending" };
  const list = decideAddList({
    sourceName: names.get(reply?.source ?? tab) ?? tab,
    names,
    text: search?.text ?? "",
    isLink,
    isOffline: false,
    scope: undefined,
    search: searchState,
  });
  const rows = list.kind === "results" ? listLinkableRows(list.rows, selfRef, links) : [];
  const note =
    list.kind === "searching" || list.kind === "message"
      ? list.text
      : list.kind === "results" && rows.length === 0
        ? "Everything found is already linked."
        : undefined;

  const submit = (): void => {
    if (text.trim() !== (search?.text ?? "")) {
      // The list on screen is for older words, so Return searches the new ones first.
      setSearch(buildEntitySearch(text, tab, ""));
      return;
    }
    const first = rows[0];
    if (first !== undefined) onPick(first);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

  return (
    <div className="open-card-find" onKeyDown={closeOnEscape}>
      {sources.length > 1 && (
        <ViewSwitch
          className="seg open-card-sources"
          label="Source"
          choices={sources.map((source) => ({
            view: source.id,
            label: source.name,
            mark: <PluginMark pluginId={source.id} plugins={plugins} size={14} />,
          }))}
          view={tab}
          onPick={(id) => {
            setTab(id);
            setSearch(buildEntitySearch(text, id, ""));
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
          className="open-card-find-input"
          value={text}
          placeholder={PLACEHOLDER}
          aria-label="Link something"
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim() === "") setSearch(null);
          }}
        />
      </form>
      {note !== undefined && (
        <p className="open-card-found-note" aria-live="polite">
          {note}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="open-card-found">
          {rows.map((row) => (
            <li key={row.ref}>
              <button
                type="button"
                className="open-card-found-go"
                onClick={() => {
                  onPick(row);
                }}
              >
                <span className="open-card-found-mark">
                  <PluginMark pluginId={reply?.source ?? tab} plugins={plugins} size={14} />
                </span>
                <span className="open-card-found-title">{row.title}</span>
                <small>{row.identifier}</small>
                {row.state !== "" && <span className="open-card-found-state">{row.state}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders the way to link something to the open thing, at the foot of the
 * Linked section: a "Link something" button that opens a search. Choosing a
 * row calls `onPick` with it and closes the search.
 *
 * - `selfRef` and `links` decide which results can be linked: not the thing
 *   itself, and not what is already linked (`listLinkableRows`).
 * - `ownPluginId` is the plugin that owns the open thing. The search starts
 *   on another source when there is one, because a link between two sources
 *   is the usual one: a ticket and its pull request.
 *
 * The plugins are read only once the search opens.
 */
export function OpenCardLinkSearch({
  client,
  selfRef,
  links,
  ownPluginId,
  onPick,
}: {
  readonly client: HerculeClient;
  readonly selfRef: string;
  readonly links: readonly EntityLink[];
  readonly ownPluginId: string;
  readonly onPick: (row: AddRow) => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="open-card-add">
      {isOpen ? (
        <OpenSearch
          client={client}
          selfRef={selfRef}
          links={links}
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
          className="open-card-add-go"
          onClick={() => {
            setIsOpen(true);
          }}
        >
          <LinkIcon size={12} />
          Link something
        </button>
      )}
    </div>
  );
}

/** Reads the plugins and draws the search on the first source that can be searched, or says there is none. */
function OpenSearch({
  client,
  selfRef,
  links,
  ownPluginId,
  onPick,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly selfRef: string;
  readonly links: readonly EntityLink[];
  readonly ownPluginId: string;
  readonly onPick: (row: AddRow) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const sources = listAddSources(plugins);
  const start = sources.find((source) => source.id !== ownPluginId) ?? sources[0];
  if (start === undefined) {
    return (
      <p className="open-card-found-note">No source can be searched. Add a Connection first.</p>
    );
  }
  return (
    <SourceLinkSearch
      client={client}
      sources={sources}
      names={new Map(plugins.map((plugin) => [plugin.id, plugin.displayName]))}
      plugins={plugins}
      initialSource={start.id}
      selfRef={selfRef}
      links={links}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
