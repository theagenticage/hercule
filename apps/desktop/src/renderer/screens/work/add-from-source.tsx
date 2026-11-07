import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  buildSuggestionGroups,
  decideAddList,
  describeAddedLine,
  describeSearchLine,
  describeSearchPlaceholder,
  isPastedLink,
  listAddSources,
  listScopeOptions,
  nameTaskStage,
  type AddOpening,
  type AddRow,
  type AddSource,
  type SearchState,
} from "@hercule/client-core/work";
import type { EntityPlace, EntitySearchReply, PluginDetail } from "@hercule/contract";
import { entitySearchQuery, entitySuggestionsQuery, pluginsQuery } from "../../app/queries";
import type { Gesture } from "../../app/undo-stack";
import { AddSourcePanel, type SuggestionsView } from "./add-source-panel";

/** How long typing must stop before a search is sent, in milliseconds. */
const TYPING_PAUSE_MS = 180;

/** What the sheet tells its page when a thing was added. */
export interface AddedThing {
  /** The Task that now has the thing. */
  readonly taskId: string;
  /** The line for the foot of the page, such as "Added to Exploring. Hercule now follows WEB-301." */
  readonly line: string;
  /** How to take the add back. Absent when the thing already had a Task, so nothing was added. */
  readonly gesture: Gesture<unknown> | undefined;
}

/** A row that was added since the sheet opened: its stage once known, and the list it was added from. */
interface AddedRow {
  readonly stage: string | undefined;
  /** The scope of the suggestions it was added from, which stop being read while it stays added. */
  readonly scopeRef: string;
}

/**
 * Renders the From a source part of the Add to Work sheet, and does what it
 * asks: it reads the suggestions and searches the source live, and adds a
 * thing to Work.
 *
 * - Typing waits for a pause of 180ms before it searches, and the answer of
 *   an older search is never shown once a newer one was made. Return adds the
 *   first thing of the list. When the pause has not passed yet, Return
 *   searches at once instead.
 * - A pasted link changes the tab to the source that answered it.
 * - An add turns its row into a check at once. The row stays where it is,
 *   and the suggestions are not read again while a row from them stays added,
 *   so nothing slides under the pointer. A failed add puts the row back and
 *   `onFailed` says why. Offline, an add fails and says so: nothing is kept
 *   to send later.
 * - Esc clears what is typed. With nothing typed it does nothing here, and
 *   the sheet closes.
 *
 * `places` are the stored places the Work board holds, which are the
 * contexts the select offers. `opening` says which source and context the
 * sheet starts on. A change of `opening` needs a new component (a `key`),
 * because the sheet then starts again. Draws nothing when no plugin is a
 * source.
 */
export function AddFromSource({
  client,
  places,
  opening,
  isOffline,
  onAdded,
  onFailed,
  onOpenTask,
}: {
  readonly client: HerculeClient;
  readonly places: ReadonlyArray<EntityPlace>;
  readonly opening: AddOpening;
  readonly isOffline: boolean;
  readonly onAdded: (added: AddedThing) => void;
  readonly onFailed: (message: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}): JSX.Element | null {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const sources = listAddSources(plugins);
  const first = sources[0];
  if (first === undefined) return null;
  const openingSource = sources.find((source) => source.id === opening.sourceId) ?? first;
  return (
    <SourceSearch
      client={client}
      plugins={plugins}
      sources={sources}
      places={places}
      initialSource={openingSource.id}
      initialScopeRef={openingSource.id === opening.sourceId ? (opening.scopeRef ?? "") : ""}
      isOffline={isOffline}
      onAdded={onAdded}
      onFailed={onFailed}
      onOpenTask={onOpenTask}
    />
  );
}

/** What is being searched: the words once typing stopped, and the source and context they were asked of. */
interface Search {
  readonly source: string;
  readonly text: string;
  readonly scopeRef?: string;
}

/**
 * Returns the search for `words` in `source`, narrowed to `scopeRef` unless that
 * is empty, or `null` when nothing is typed. A pasted link is never narrowed:
 * it names its own source and its own thing.
 */
const buildSearch = (words: string, source: string, scopeRef: string): Search | null => {
  const text = words.trim();
  if (text === "") return null;
  return { source, text, ...(scopeRef === "" || isPastedLink(text) ? {} : { scopeRef }) };
};

function SourceSearch({
  client,
  plugins,
  sources,
  places,
  initialSource,
  initialScopeRef,
  isOffline,
  onAdded,
  onFailed,
  onOpenTask,
}: {
  readonly client: HerculeClient;
  readonly plugins: ReadonlyArray<PluginDetail>;
  readonly sources: readonly AddSource[];
  readonly places: ReadonlyArray<EntityPlace>;
  readonly initialSource: string;
  readonly initialScopeRef: string;
  readonly isOffline: boolean;
  readonly onAdded: (added: AddedThing) => void;
  readonly onFailed: (message: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState(initialSource);
  const [chosenScopeRef, setChosenScopeRef] = useState(initialScopeRef);
  const [text, setText] = useState("");
  // It keeps the source the words were sent to, so a link that moves the tab
  // does not ask the question again.
  const [search, setSearch] = useState<Search | null>(null);
  const [added, setAdded] = useState<ReadonlyMap<string, AddedRow>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.displayName]));
  const sourceName = (id: string): string => names.get(id) ?? id;
  const scopeOptions = listScopeOptions(places, tab);
  const scope = scopeOptions.find((option) => option.ref === chosenScopeRef);
  const scopeRef = scope?.ref ?? "";

  // Keys go to the search first.
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  // A search waits for typing to stop. Clearing the field does not wait.
  useEffect(() => {
    if (text.trim() === (search?.text ?? "")) return;
    const timer = setTimeout(() => {
      setSearch(buildSearch(text, tab, scopeRef));
    }, TYPING_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, search, tab, scopeRef]);

  const searchRead = useQuery({
    ...entitySearchQuery(client, search ?? undefined),
    enabled: search !== null && !isOffline,
  });
  const reply = searchRead.data;

  // An answer that says the link is from another source moves the tab there.
  const [lastReply, setLastReply] = useState<EntitySearchReply | undefined>(undefined);
  if (reply !== undefined && reply !== lastReply) {
    setLastReply(reply);
    if (reply.source !== tab && sources.some((source) => source.id === reply.source)) {
      setTab(reply.source);
      setChosenScopeRef("");
    }
  }

  const isSuggestionsFrozen = [...added.values()].some((row) => row.scopeRef === scopeRef);
  const suggestionsRead = useQuery({
    ...entitySuggestionsQuery(client, scopeRef === "" ? undefined : scopeRef),
    // Once something is added from this list, the list is not read again: a
    // read would drop the thing, and the row below the pointer would slide up.
    enabled: !isSuggestionsFrozen,
  });

  const isLink = search !== null && isPastedLink(search.text);
  const searchState: SearchState =
    search === null || isOffline
      ? { status: "idle" }
      : reply !== undefined
        ? { status: "answered", reply }
        : searchRead.error !== null
          ? { status: "failed", reason: readErrorMessage(searchRead.error) }
          : { status: "pending" };
  const list = decideAddList({
    sourceName: sourceName(reply?.source ?? tab),
    names,
    text: search?.text ?? "",
    isLink,
    isOffline,
    scope,
    search: searchState,
  });
  const suggestions: SuggestionsView =
    suggestionsRead.data !== undefined
      ? {
          status: "ready",
          groups: buildSuggestionGroups({
            reply: suggestionsRead.data,
            places,
            sourceId: tab,
            scopeRef: scope?.ref,
            // Offline, typing is all that can be done with the list.
            narrowedBy: isOffline ? text : "",
          }),
        }
      : suggestionsRead.error !== null
        ? { status: "failed", reason: readErrorMessage(suggestionsRead.error) }
        : { status: "loading" };

  const addToWork = useMutation({
    mutationFn: (row: AddRow) => client.externalEntity.addToWork({ payload: { ref: row.ref } }),
    onSuccess: (result, row) => {
      setAdded((before) => {
        const current = before.get(row.ref);
        return current === undefined
          ? before
          : new Map(before).set(row.ref, { ...current, stage: nameTaskStage(result.stage) });
      });
      onAdded({
        taskId: result.taskId,
        line: describeAddedLine({
          stage: result.stage,
          identifier: row.identifier,
          followed: result.followed,
          created: result.created,
        }),
        gesture: result.created
          ? {
              words: `Added ${row.identifier} to Work`,
              undo: async () => {
                const outcome = await client.externalEntity.undoTakeOn({
                  params: { id: result.id },
                  payload: { taskId: result.taskId },
                });
                if (!outcome.undone) {
                  throw new Error(outcome.reason ?? "The Task has changed since it was added.");
                }
                setAdded((before) => {
                  const rest = new Map(before);
                  rest.delete(row.ref);
                  return rest;
                });
                return undefined;
              },
            }
          : undefined,
      });
    },
    onError: (error, row) => {
      setAdded((before) => {
        const rest = new Map(before);
        rest.delete(row.ref);
        return rest;
      });
      onFailed(
        isOffline
          ? `You are offline, so ${row.identifier} was not added. Try again when you are back.`
          : `Could not add ${row.identifier}: ${readErrorMessage(error)}`,
      );
    },
  });

  const add = (row: AddRow): void => {
    setAdded((before) => new Map(before).set(row.ref, { stage: undefined, scopeRef }));
    addToWork.mutate(row);
    // The row went quiet, so the keys go back to the search, ready for the next one.
    searchRef.current?.focus({ preventScroll: true });
  };

  const shownRows =
    list.kind === "results"
      ? list.rows
      : list.kind === "suggestions" && suggestions.status === "ready"
        ? suggestions.groups.flatMap((group) => group.rows)
        : [];
  const submit = (): void => {
    if (text.trim() !== (search?.text ?? "")) {
      // The list on screen is for older words, so Return searches the new ones first.
      setSearch(buildSearch(text, tab, scopeRef));
      return;
    }
    const firstAddable = shownRows.find((row) => row.taskId === undefined && !added.has(row.ref));
    if (firstAddable !== undefined) add(firstAddable);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || text === "") return;
    event.stopPropagation();
    setText("");
    setSearch(null);
    searchRef.current?.focus({ preventScroll: true });
  };

  return (
    <AddSourcePanel
      sources={sources}
      plugins={plugins}
      sourceId={tab}
      onPickSource={(id) => {
        const nextScopeRef = id === initialSource ? initialScopeRef : "";
        setTab(id);
        setChosenScopeRef(nextScopeRef);
        setSearch(buildSearch(text, id, nextScopeRef));
        searchRef.current?.focus({ preventScroll: true });
      }}
      text={text}
      placeholder={describeSearchPlaceholder(sourceName(tab))}
      searchRef={searchRef}
      onTextChange={(next) => {
        setText(next);
        if (next.trim() === "") setSearch(null);
      }}
      onSubmit={submit}
      onKeyDown={handleKeyDown}
      line={describeSearchLine({
        sourceName: sourceName(tab),
        scope,
        isOffline,
        isLink,
        linkSourceName: reply === undefined ? undefined : sourceName(reply.source),
      })}
      scopeOptions={scopeOptions}
      scopeRef={scopeRef}
      onScopeChange={(next) => {
        setChosenScopeRef(next);
        setSearch(buildSearch(text, tab, next));
      }}
      list={list}
      suggestions={suggestions}
      added={new Map([...added].map(([ref, row]) => [ref, row.stage]))}
      onAdd={add}
      onOpenTask={onOpenTask}
      onWiden={() => {
        setChosenScopeRef("");
        setSearch(buildSearch(text, tab, ""));
      }}
    />
  );
}
