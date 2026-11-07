import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  buildEntitySearch,
  buildSuggestionGroups,
  decideAddList,
  describeAddedLine,
  describeSearchLine,
  describeSearchPlaceholder,
  isPastedLink,
  listAddSources,
  listScopeOptions,
  mergePlaces,
  nameTaskStage,
  type AddOpening,
  type AddRow,
  type AddSource,
  type SearchState,
} from "@hercule/client-core/work";
import type {
  EntityPlace,
  EntitySearchQuery,
  EntitySearchReply,
  EntitySuggestions,
  PluginDetail,
} from "@hercule/contract";
import {
  entitySearchQuery,
  entitySuggestionsQuery,
  inboxQuery,
  pluginsQuery,
} from "../../app/queries";
import { undoAddedTask } from "../../app/undo-added-task";
import type { Gesture } from "../../app/undo-stack";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { SearchIcon } from "../../icons/search";
import { PluginMark } from "../../marks";
import { ViewSwitch } from "../view-switch";
import { AddList, type SuggestionsView } from "./add-list";

/** How long typing must stop before a search is sent, in milliseconds. */
const TYPING_PAUSE_MS = 180;

/** What the sheet tells its page when a thing was added. */
export interface AddedThing {
  /** The Task that now has the thing. */
  readonly taskId: string;
  /** The line for the foot of the page, such as "Added to Exploring. Hercule now follows WEB-301." */
  readonly line: string;
  /** Whether the add made the Task. False when the thing already had one, so nothing was added. */
  readonly wasCreated: boolean;
  /** The gesture reserved on the undo stack for this add, which the line offers Undo for. */
  readonly gesture: Gesture<unknown>;
}

/**
 * Puts a gesture on the undo stack the moment the user adds something, before
 * the controller answers (see `UndoStack.reserve` for `willHold`).
 */
export type ReserveGesture = (gesture: Gesture<unknown>, willHold: Promise<boolean>) => void;

/** A row that was added since the sheet opened: its stage once known, and the list it was added from. */
interface AddedRow {
  readonly stage: string | undefined;
  /** The scope of the suggestions it was added from. */
  readonly scopeRef: string;
  /**
   * The suggestions of that scope as they were shown when the first row was
   * added from them. They are shown unchanged, and not read again, while a row
   * from them stays added. Absent when they were not read yet.
   */
  readonly suggestions: EntitySuggestions | undefined;
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
 *   and the suggestions are shown as they were, and not read again, while a
 *   row from them stays added, so nothing slides under the pointer. Taking
 *   the add back, or a failed add, puts the row back and the live list returns.
 *   A failed add also calls `onFailed` to say why. Offline, an add fails and says so: nothing is kept
 *   to send later.
 * - Esc clears what is typed. With nothing typed it does nothing here, and
 *   the sheet closes.
 *
 * `places` are the stored places the Work board holds. The contexts the
 * select offers are these, plus the places of the suggestions and of the
 * Inbox when it was read. `opening` says which source and context the
 * sheet starts on. `projectId` is the Project that every Task added here joins,
 * or `null` for none. A change of `opening` needs a new component (a `key`),
 * because the sheet then starts again. Draws nothing when no plugin is a
 * source.
 */
export function AddFromSource({
  client,
  places,
  opening,
  projectId,
  isOffline,
  reserveGesture,
  onAdded,
  onFailed,
  onOpenTask,
}: {
  readonly client: HerculeClient;
  readonly places: ReadonlyArray<EntityPlace>;
  readonly opening: AddOpening;
  readonly projectId: string | null;
  readonly isOffline: boolean;
  readonly reserveGesture: ReserveGesture;
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
      projectId={projectId}
      isOffline={isOffline}
      reserveGesture={reserveGesture}
      onAdded={onAdded}
      onFailed={onFailed}
      onOpenTask={onOpenTask}
    />
  );
}

function SourceSearch({
  client,
  plugins,
  sources,
  places,
  initialSource,
  initialScopeRef,
  projectId,
  isOffline,
  reserveGesture,
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
  readonly projectId: string | null;
  readonly isOffline: boolean;
  readonly reserveGesture: ReserveGesture;
  readonly onAdded: (added: AddedThing) => void;
  readonly onFailed: (message: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState(initialSource);
  const [chosenScopeRef, setChosenScopeRef] = useState(initialScopeRef);
  const [text, setText] = useState("");
  // It keeps the source the words were sent to, so a link that moves the tab
  // does not ask the question again.
  const [search, setSearch] = useState<EntitySearchQuery | null>(null);
  const [added, setAdded] = useState<ReadonlyMap<string, AddedRow>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  // The gesture reserved for each add that is on its way, by the ref of the thing, until its answer says the line.
  const reservedGestures = useRef(new Map<string, Gesture<unknown>>());

  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.displayName]));
  const sourceName = (id: string): string => names.get(id) ?? id;

  // Once something is added from a list, that list stays as it was shown and
  // is not read again: a read would drop the thing, and the rows below it
  // would slide up. A read that was already on its way is ignored too, because
  // the list shown is this snapshot and not the cache. Undoing the add, or a
  // failed add, removes the row, and then the live list shows again.
  const frozenSuggestions = [...added.values()].find(
    (row) => row.scopeRef === chosenScopeRef && row.suggestions !== undefined,
  )?.suggestions;
  const suggestionsRead = useQuery({
    ...entitySuggestionsQuery(client, chosenScopeRef === "" ? undefined : chosenScopeRef),
    enabled: frozenSuggestions === undefined,
  });
  const shownSuggestions = frozenSuggestions ?? suggestionsRead.data;

  // The contexts the select offers: those of the Work board, those the
  // suggestions mention, and those the Inbox holds if it was read. The Inbox is
  // only looked at here, never read, so the sheet makes no read of its own for them.
  const cachedInbox = useQuery({ ...inboxQuery(client), enabled: false });
  const knownPlaces = mergePlaces(
    places,
    cachedInbox.data?.places ?? [],
    shownSuggestions?.places ?? [],
  );
  const scopeOptions = listScopeOptions(knownPlaces, tab);
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
      setSearch(buildEntitySearch(text, tab, scopeRef));
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
    shownSuggestions !== undefined
      ? {
          status: "ready",
          groups: buildSuggestionGroups({
            reply: shownSuggestions,
            places: knownPlaces,
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
    mutationFn: (row: AddRow) =>
      client.externalEntity.addToWork({
        payload: { ref: row.ref, ...(projectId === null ? {} : { projectId }) },
      }),
    onSuccess: (result, row) => {
      // A Task this call made always has an entity: only an existing Task can come back without one.
      const entityId = result.id;
      setAdded((before) => {
        const current = before.get(row.ref);
        return current === undefined
          ? before
          : new Map(before).set(row.ref, { ...current, stage: nameTaskStage(result.stage) });
      });
      const gesture = reservedGestures.current.get(row.ref);
      reservedGestures.current.delete(row.ref);
      if (gesture === undefined) return;
      onAdded({
        taskId: result.taskId,
        line: describeAddedLine({
          stage: result.stage,
          identifier: row.identifier,
          followed: result.followed,
          created: result.created,
        }),
        wasCreated: result.created && entityId !== undefined,
        gesture,
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
    setAdded((before) =>
      new Map(before).set(row.ref, {
        stage: undefined,
        scopeRef: chosenScopeRef,
        suggestions: shownSuggestions,
      }),
    );
    // What the add made, or `undefined` when it failed or the thing already had a Task: nothing to take back.
    const made = addToWork.mutateAsync(row).then(
      (result) =>
        result.created && result.id !== undefined
          ? { entityId: result.id, taskId: result.taskId }
          : undefined,
      () => undefined,
    );
    const gesture: Gesture<unknown> = {
      words: `Added ${row.identifier} to Work`,
      undo: async () => {
        const task = await made;
        if (task === undefined) {
          throw new Error("That add changed nothing, so there is nothing to take back.");
        }
        await undoAddedTask(client, task.entityId, task.taskId);
        setAdded((before) => {
          const rest = new Map(before);
          rest.delete(row.ref);
          return rest;
        });
        return undefined;
      },
    };
    reservedGestures.current.set(row.ref, gesture);
    reserveGesture(
      gesture,
      made.then((task) => task !== undefined),
    );
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
      setSearch(buildEntitySearch(text, tab, scopeRef));
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

  const placeholder = describeSearchPlaceholder(sourceName(tab));
  const line = describeSearchLine({
    sourceName: sourceName(tab),
    scope,
    isOffline,
    isLink,
    linkSourceName: reply === undefined ? undefined : sourceName(reply.source),
  });
  const changeScope = (next: string): void => {
    setChosenScopeRef(next);
    setSearch(buildEntitySearch(text, tab, next));
  };

  return (
    <section className="add-from" aria-label="From a source" onKeyDown={handleKeyDown}>
      <h3 className="add-from-title">From a source</h3>
      <ViewSwitch
        className="seg add-sources"
        label="Source"
        choices={sources.map((source) => ({
          view: source.id,
          label: source.name,
          mark: <PluginMark pluginId={source.id} plugins={plugins} size={14} />,
        }))}
        view={tab}
        onPick={(id) => {
          const nextScopeRef = id === initialSource ? initialScopeRef : "";
          setTab(id);
          setChosenScopeRef(nextScopeRef);
          setSearch(buildEntitySearch(text, id, nextScopeRef));
          searchRef.current?.focus({ preventScroll: true });
        }}
      />
      <form
        className="add-search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SearchIcon size={15} />
        <input
          ref={searchRef}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim() === "") setSearch(null);
          }}
        />
      </form>
      {line.kind !== "scope" ? (
        <p className={line.kind === "offline" ? "add-reach is-off" : "add-reach"}>{line.text}</p>
      ) : (
        <label className="add-reach">
          <span>{line.lead}</span>
          <span className="add-reach-pick">
            <select
              aria-label="Narrow the search"
              value={scopeRef}
              onChange={(event) => {
                changeScope(event.target.value);
              }}
            >
              <option value="">{line.allLabel}</option>
              {scopeOptions.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={11} />
          </span>
          {line.trailing !== null && <span>{line.trailing}</span>}
        </label>
      )}
      <div className="add-list" aria-live="polite" aria-busy={list.kind === "searching"}>
        <AddList
          list={list}
          suggestions={suggestions}
          added={new Map([...added].map(([ref, row]) => [ref, row.stage]))}
          onAdd={add}
          onOpenTask={onOpenTask}
          onWiden={() => {
            changeScope("");
          }}
        />
      </div>
    </section>
  );
}
