/**
 * Intake's Everything view: the events behind the signals, in a list and a
 * pane beside it (spec 17 §Everything).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { useInfiniteQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { MAX_SEARCH_TEXT_LENGTH, type EventHandling } from "@hercule/contract";
import {
  describeEventHorizon,
  EVENT_HANDLING_OPTIONS,
  groupEventsByDay,
  moveEventSelection,
  queryKeys,
  readErrorMessage,
  resolveDisplayTimezone,
  type IntakeView,
} from "@hercule/client-core";
import { eventsEverythingQuery, settingsQuery } from "../../app/queries";
import { SearchIcon } from "../../icons/search";
import { EventPane, type EventPaneHandle } from "./event-pane";
import { EverythingList } from "./everything-list";
import { IntakeBar, IntakeSplit, IntakeViewSwitcher, isTextField } from "./intake-split";
import { useIntakeSplit } from "./use-intake-split";
import { useIntakeTabs } from "./use-intake-tabs";

/** How long typing in the search field pauses before the list is read again, in milliseconds. */
const SEARCH_WAIT_MS = 200;

/**
 * Renders Everything: the bar with its source tabs and the pane's toggle,
 * then the split of the list and the pane. Above the list, the view switcher,
 * the search field, the filter menu and the horizon the list reaches back to.
 *
 * `text`, `handling` and `selectedId` come from the URL. The screen keeps
 * what the user types in the search field and calls `onSearchChange` once
 * typing has paused, so the list is not read again for each key. A new search
 * or filter starts a new list, and the route drops the selection with it.
 *
 * The keys of spec 17 §Keys act while the focus is in the list or the pane
 * and never in a text field:
 *
 * - `J`/`K` and `↓`/`↑` move the selection.
 * - `↩` on a row opens the pane, as a click does.
 * - `O` opens the event on its system.
 * - Esc closes the pane, and then clears the selection.
 */
export function EverythingScreen({
  pluginId,
  text,
  handling,
  selectedId,
  onSelect,
  onSearchChange,
  onHandlingChange,
  onViewChange,
  onPluginChange,
}: {
  /** The pressed source tab, `null` for All. */
  readonly pluginId: string | null;
  /** The search the list shows, empty for none. */
  readonly text: string;
  /** The filter the list shows, `null` for every event. */
  readonly handling: EventHandling | null;
  readonly selectedId: number | null;
  readonly onSelect: (eventId: number | null) => void;
  readonly onSearchChange: (text: string) => void;
  readonly onHandlingChange: (handling: EventHandling | null) => void;
  readonly onViewChange: (view: IntakeView) => void;
  readonly onPluginChange: (pluginId: string | null) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { tabs, plugins } = useIntakeTabs(pluginId);
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const [focusSelectedRow, setFocusSelectedRow] = useState(false);
  const split = useIntakeSplit(selectedId === null ? null : String(selectedId), "data-event-id");
  const { listRef, fits, paneShown, paneDrawn, setDismissed } = split;
  const paneRef = useRef<EventPaneHandle>(null);
  // Read by `openEvent` when it runs, so it keeps one identity while `J` and
  // `K` change the selection, and the list's rows, which are memoized, do not
  // draw again.
  const selectedIdRef = useRef(selectedId);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const [draft, setDraft] = useState(text);
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === text) return;
    const timer = setTimeout(() => {
      onSearchChange(trimmed);
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, text, onSearchChange]);

  const paged = useInfiniteQuery(
    eventsEverythingQuery(client, {
      ...(pluginId === null ? {} : { source: pluginId }),
      ...(text === "" ? {} : { text }),
      ...(handling === null ? {} : { handling }),
    }),
  );
  const events = useMemo(() => paged.data?.pages.flatMap((page) => page.items) ?? [], [paged.data]);
  // The sections name their days against the moment the listing was read.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `dataUpdatedAt` is the reason to take the time again.
  const now = useMemo(() => new Date(), [paged.dataUpdatedAt]);
  const sections = useMemo(() => groupEventsByDay(events, now, timezone), [events, now, timezone]);
  const selectedEvent = events.find((event) => event.id === selectedId);

  /** Selects `eventId` and shows the pane, as a click on its row does. */
  const openEvent = useCallback(
    (eventId: number): void => {
      setDismissed(false);
      if (eventId !== selectedIdRef.current) onSelect(eventId);
    },
    [setDismissed, onSelect],
  );

  const moveSelection = (step: 1 | -1): void => {
    const next = moveEventSelection(events, selectedId, step);
    if (next === null || next === selectedId) return;
    // The pane draws the new event from scratch, which drops the focus
    // inside it, so the focus goes to the list and stays on the keys' side.
    if (!(listRef.current?.contains(document.activeElement) ?? false)) setFocusSelectedRow(true);
    onSelect(next);
  };

  const stepBack = (): void => {
    if (paneShown) {
      setDismissed(true);
      return;
    }
    if (selectedId !== null) {
      setDismissed(false);
      onSelect(null);
    }
  };

  const hasNextPage = paged.hasNextPage;
  const isFetchingNextPage = paged.isFetchingNextPage;
  const fetchNextPage = paged.fetchNextPage;
  const readNextPage = useCallback((): void => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    switch (key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        return;
      // The closed pane stays drawn, off screen, so this key checks that it shows.
      case "o":
        event.preventDefault();
        if (paneShown) paneRef.current?.openInSystem();
        return;
      case "Escape":
        event.preventDefault();
        stepBack();
        return;
    }
  };

  const canToggle = fits && (paneShown || events.length > 0);
  const toggleTitle = !fits
    ? "Widen the window to show the pane"
    : paneShown
      ? "Hide the event  Esc"
      : "Show the event";
  const filtered = text !== "" || handling !== null || pluginId !== null;

  return (
    <>
      <IntakeBar
        tabs={tabs}
        pluginId={pluginId}
        plugins={plugins}
        paneLabel="Event pane"
        paneToggle={{
          title: toggleTitle,
          shown: paneShown,
          enabled: canToggle,
          onPress: () => {
            if (paneShown) setDismissed(true);
            else openEvent(selectedId ?? events[0]!.id);
          },
        }}
        onTabChange={(next) => {
          // The tab starts another listing. Every listing held is marked stale
          // so the one the tab shows is read again, as when Intake opens.
          void queryClient.invalidateQueries({ queryKey: queryKeys.events(), refetchType: "none" });
          onPluginChange(next);
        }}
      />
      <IntakeSplit
        split={split}
        listLabel="Events"
        onKeyDown={handleKeys}
        list={
          <>
            <div className="asks-head">
              <IntakeViewSwitcher view="everything" onViewChange={onViewChange} />
              <div className="asks-find">
                <label className="field asks-search">
                  <SearchIcon size={14} />
                  <input
                    type="search"
                    placeholder="Search events"
                    aria-label="Search events"
                    maxLength={MAX_SEARCH_TEXT_LENGTH}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                    }}
                  />
                </label>
                <label className="field field--select asks-stamp">
                  <select
                    aria-label="What came of it"
                    value={handling ?? ""}
                    onChange={(event) => {
                      const chosen = EVENT_HANDLING_OPTIONS.find(
                        (option) => (option.handling ?? "") === event.target.value,
                      );
                      onHandlingChange(chosen?.handling ?? null);
                    }}
                  >
                    {EVENT_HANDLING_OPTIONS.map((option) => (
                      <option key={option.handling ?? "all"} value={option.handling ?? ""}>
                        {option.caption}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="asks-horizon">
                {describeEventHorizon(settings.controller?.["retention.events"])}
              </p>
            </div>
            <EverythingList
              sections={sections}
              plugins={plugins}
              selectedId={selectedId}
              now={now}
              timezone={timezone}
              focusSelectedRow={focusSelectedRow}
              empty={
                paged.isPending ? null : paged.isError ? (
                  <p className="asks-empty" role="alert">
                    {readErrorMessage(paged.error)}
                  </p>
                ) : (
                  <p className="asks-empty">{filtered ? "No events match." : "No events yet."}</p>
                )
              }
              foot={
                events.length > 0 &&
                !paged.hasNextPage && <p className="asks-end">No older events.</p>
              }
              onSelect={openEvent}
              onNearEnd={readNextPage}
              onFocusedSelectedRow={() => {
                setFocusSelectedRow(false);
              }}
            />
          </>
        }
        pane={
          selectedId !== null &&
          paneDrawn && (
            <EventPane
              key={selectedId}
              eventId={selectedId}
              listed={selectedEvent}
              timezone={timezone}
              shown={paneShown}
              ref={paneRef}
            />
          )
        }
      />
    </>
  );
}
