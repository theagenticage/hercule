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
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { MAX_SEARCH_TEXT_LENGTH, type EventHandling } from "@hercule/contract";
import {
  computeEventHorizonStart,
  describeEventHorizon,
  describeEventListEnd,
  EVENT_HANDLING_OPTIONS,
  groupEventsByDay,
  moveEventSelection,
  readErrorMessage,
  resolveDisplayTimezone,
  type IntakeView,
} from "@hercule/client-core";
import { eventsEverythingQuery, settingsQuery } from "../../app/queries";
import { SearchIcon } from "../../icons/search";
import { EventPane, type EventPaneHandle } from "./event-pane";
import { EverythingList } from "./everything-list";
import { IntakeBar, IntakeSplit, IntakeViewSwitcher } from "./intake-frame";
import { isTextField } from "../../app/text-field";
import { useIntakeSplit } from "./use-intake-split";
import { useIntakeTabs } from "./use-intake-tabs";

/** How long typing in the search field pauses before the list is read again, in milliseconds. */
const SEARCH_WAIT_MS = 200;

/** Returns the value of the filter menu's option for `handling`; "All events" is the empty string. */
const toSelectValue = (handling: EventHandling | null): string => handling ?? "";

/** Draws the error of a failed read as a line of the list, with a Retry that asks again. */
function ReadFailure({
  error,
  onRetry,
}: {
  readonly error: Error | null;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <p className="asks-note asks-note--failed" role="alert">
      <span>{readErrorMessage(error)}</span>
      <button type="button" className="btn btn--sm btn--quiet" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

/**
 * Renders Everything: the bar with its source tabs and the pane's toggle,
 * then the split of the list and the pane. Above the list, the view switcher,
 * the search field, the filter menu and the horizon the list reaches back to.
 *
 * `pluginId` (the source tab), `text`, `handling` and `selectedId` come from
 * the URL. The screen keeps what the user types in the search field and calls
 * `onSearchChange` once typing has paused, so the list is not read again for
 * each key. Only typing starts that wait: a `text` that arrives from outside,
 * such as a link, replaces what the field holds and ends any wait. A new
 * search, filter or tab starts a new list, and the route drops the selection
 * with it.
 *
 * `openedAt` is the moment the route loaded the list. The screen takes it as
 * "now" for the day headings and the row times, and counts the retention
 * horizon from it, so neither moves while the list stays.
 *
 * A page that fails to load ends the list with its error and a Retry. The list
 * does not ask for that page again until Retry is pressed.
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
  openedAt,
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
  /** When the route loaded the list, in milliseconds since the epoch. */
  readonly openedAt: number;
  readonly onSelect: (eventId: number | null) => void;
  readonly onSearchChange: (text: string) => void;
  readonly onHandlingChange: (handling: EventHandling | null) => void;
  readonly onViewChange: (view: IntakeView) => void;
  readonly onPluginChange: (pluginId: string | null) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { tabs, plugins } = useIntakeTabs(pluginId);
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const retentionDays = settings.controller?.["retention.events"];
  const now = useMemo(() => new Date(openedAt), [openedAt]);
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

  // The field holds what the user typed. `sentText` is the last `text` this
  // screen either sent to the route or saw there: a `text` that differs from it
  // came from outside, and replaces the field.
  const [draft, setDraft] = useState(text);
  const [waiting, setWaiting] = useState(false);
  const [sentText, setSentText] = useState(text);
  if (text !== sentText) {
    setSentText(text);
    setDraft(text);
    setWaiting(false);
  }
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      const trimmed = draft.trim();
      setWaiting(false);
      if (trimmed === text) return;
      setSentText(trimmed);
      onSearchChange(trimmed);
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [waiting, draft, text, onSearchChange]);

  const paged = useInfiniteQuery(
    eventsEverythingQuery(
      client,
      { text, source: pluginId ?? undefined, handling: handling ?? undefined },
      computeEventHorizonStart(now, retentionDays),
    ),
  );
  const events = useMemo(() => paged.data?.pages.flatMap((page) => page.items) ?? [], [paged.data]);
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
  const nextPageFailed = paged.isFetchNextPageError;
  const fetchNextPage = paged.fetchNextPage;
  // A failed page is not asked for again by scrolling: the list is still near
  // its end, so that would loop. The Retry at the end of the list asks again.
  const readNextPage = useCallback((): void => {
    if (hasNextPage && !isFetchingNextPage && !nextPageFailed) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, nextPageFailed, fetchNextPage]);

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
        onTabChange={onPluginChange}
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
                      setWaiting(true);
                    }}
                  />
                </label>
                <label className="field field--select asks-stamp">
                  <select
                    aria-label="What came of it"
                    value={toSelectValue(handling)}
                    onChange={(event) => {
                      onHandlingChange(
                        EVENT_HANDLING_OPTIONS.find(
                          (option) => toSelectValue(option.handling) === event.target.value,
                        )?.handling ?? null,
                      );
                    }}
                  >
                    {EVENT_HANDLING_OPTIONS.map((option) => (
                      <option
                        key={toSelectValue(option.handling)}
                        value={toSelectValue(option.handling)}
                      >
                        {option.caption}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="asks-horizon">{describeEventHorizon(retentionDays)}</p>
            </div>
            <EverythingList
              sections={sections}
              plugins={plugins}
              selectedId={selectedId}
              now={now}
              timezone={timezone}
              focusSelectedRow={focusSelectedRow}
              empty={
                paged.isPending ? null : paged.data === undefined ? (
                  <ReadFailure error={paged.error} onRetry={() => void paged.refetch()} />
                ) : (
                  <p className="asks-note">{filtered ? "No events match." : "No events yet."}</p>
                )
              }
              foot={
                nextPageFailed ? (
                  <ReadFailure error={paged.error} onRetry={() => void fetchNextPage()} />
                ) : (
                  events.length > 0 &&
                  !hasNextPage && <p className="asks-note">{describeEventListEnd(retentionDays)}</p>
                )
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
