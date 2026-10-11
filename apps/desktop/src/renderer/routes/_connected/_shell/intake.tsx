import { useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  EVENT_HANDLINGS,
  isId,
  MAX_SEARCH_TEXT_LENGTH,
  type EventHandling,
} from "@hercule/contract";
import {
  eventsEverythingQuery,
  readInfiniteOnOpen,
  readOnOpen,
  settingsQuery,
  signalQuery,
  signalsClearedTodayQuery,
  signalsLaterQuery,
  signalsToDoQuery,
  workflowsQuery,
} from "../../../app/queries";
import { EverythingScreen } from "../../../screens/intake/everything-screen";
import { IntakeScreen } from "../../../screens/intake/intake-screen";

/**
 * The search params of Intake:
 *
 * - `view`: the view shown, Later, Done or Everything. With none, Intake shows To do.
 * - `signal`: the selected signal, whose pane is open, on To do, Later and Done.
 * - `event`: the selected event, whose pane is open, on Everything.
 * - `text` and `handling`: Everything's search and filter. With none, every event shows.
 */
export interface IntakeSearch {
  readonly view?: "later" | "done" | "everything";
  readonly signal?: string;
  readonly event?: number;
  readonly text?: string;
  readonly handling?: EventHandling;
}

/** Checks whether `value` is a handling the controller can filter events on. */
const isEventHandling = (value: unknown): value is EventHandling =>
  EVENT_HANDLINGS.some((handling) => handling === value);

/**
 * Returns Intake's search params from the URL's. A `view` that is not Later,
 * Done or Everything, a `signal` that is not an id, an `event` that is not a
 * whole number from 1, a `text` that is empty or too long, and a `handling`
 * that is not one the controller filters on are dropped.
 */
const validateIntakeSearch = (search: Record<string, unknown>): IntakeSearch => ({
  ...(search.view === "later" || search.view === "done" || search.view === "everything"
    ? { view: search.view }
    : {}),
  ...(isId(search.signal) ? { signal: search.signal } : {}),
  ...(typeof search.event === "number" && Number.isSafeInteger(search.event) && search.event >= 1
    ? { event: search.event }
    : {}),
  ...(typeof search.text === "string" &&
  search.text !== "" &&
  search.text.length <= MAX_SEARCH_TEXT_LENGTH
    ? { text: search.text }
    : {}),
  ...(isEventHandling(search.handling) ? { handling: search.handling } : {}),
});

/**
 * Intake: the signals of one view, and the selected one in a pane, or on
 * Everything the events behind them (spec 17 §Intake).
 *
 * The route is split into a chunk of its own, so Intake's code loads the
 * first time it opens, never at the app's first paint. The shell's loader
 * has already read To do, the plugins and the assistants. Each time Intake
 * opens, the loader reads the workflows, whose names label the signals their
 * runs raised: no live push keeps them current, see `workflowsQuery`. A new
 * selection does not read them again, so stepping through the list with `J`
 * sends no request for them. The loader also has the user's settings, whose
 * timezone the times on Intake are read in, the first page of Done, which
 * counts the signals cleared today, and the first page of Later, which
 * counts the snoozed signals in the view switcher.
 *
 * The loader also reads the selected signal:
 *
 * - When To do holds it, the read runs in the background. The pane opens at
 *   once on the listed signal, and the read adds its answers' describe
 *   lines.
 * - Otherwise, such as a link to a signal already resolved, the loader waits
 *   for the read, so the pane opens on the signal and not on nothing. A
 *   failed read shows in the pane.
 *
 * On Everything, the loader reads the first page of events for the search
 * and the filter in the URL. No live push keeps the events current, so each
 * time the view opens, or the search or the filter changes, the listing is
 * read again: a listing already held shows at once and is refreshed behind.
 * The selected event is not part of what the loader depends on, so `J` and
 * `K` send no request.
 *
 * The pressed source tab is state of this route, not the URL's, as on every
 * view: it survives a switch between views and ends with the window.
 */
export const Route = createFileRoute("/_connected/_shell/intake")({
  staticData: { title: "Intake" },
  validateSearch: validateIntakeSearch,
  loaderDeps: ({ search }) => ({
    view: search.view,
    signal: search.signal,
    text: search.text,
    handling: search.handling,
  }),
  loader: async ({ context: { controller, queryClient }, deps, cause }) => {
    const { client } = controller;
    const opening = Promise.all([
      cause === "stay"
        ? queryClient.ensureQueryData(workflowsQuery(client))
        : readOnOpen(queryClient, workflowsQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsClearedTodayQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsLaterQuery(client)),
      deps.view === "everything"
        ? readInfiniteOnOpen(
            queryClient,
            eventsEverythingQuery(client, {
              ...(deps.text === undefined ? {} : { text: deps.text }),
              ...(deps.handling === undefined ? {} : { handling: deps.handling }),
            }),
          )
        : undefined,
    ]);
    if (deps.signal === undefined) {
      await opening;
      return;
    }
    const listed = queryClient
      .getQueryData(signalsToDoQuery(client).queryKey)
      ?.some((signal) => signal.id === deps.signal);
    const read = queryClient.prefetchQuery(signalQuery(client, deps.signal));
    await Promise.all([opening, listed === true ? undefined : read]);
  },
  component: IntakeRoute,
});

function IntakeRoute(): JSX.Element {
  const { view, signal, event, text, handling } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [pluginId, setPluginId] = useState<string | null>(null);
  if (view === "everything") {
    return (
      <EverythingScreen
        pluginId={pluginId}
        text={text ?? ""}
        handling={handling ?? null}
        selectedId={event ?? null}
        onSelect={(eventId) => {
          // As on the signal views, the selection replaces the history entry.
          void navigate({
            search: {
              view: "everything",
              ...(text === undefined ? {} : { text }),
              ...(handling === undefined ? {} : { handling }),
              ...(eventId === null ? {} : { event: eventId }),
            },
            replace: true,
          });
        }}
        onSearchChange={(next) => {
          // A search or a filter starts a new list, so the selection goes; the
          // history entry is replaced, so Back leaves Intake rather than
          // stepping through every pause in typing.
          void navigate({
            search: {
              view: "everything",
              ...(next === "" ? {} : { text: next }),
              ...(handling === undefined ? {} : { handling }),
            },
            replace: true,
          });
        }}
        onHandlingChange={(next) => {
          void navigate({
            search: {
              view: "everything",
              ...(text === undefined ? {} : { text }),
              ...(next === null ? {} : { handling: next }),
            },
            replace: true,
          });
        }}
        onViewChange={(next) => {
          void navigate({ search: next === "to-do" ? {} : { view: next } });
        }}
        onPluginChange={setPluginId}
      />
    );
  }
  return (
    <IntakeScreen
      view={view ?? "to-do"}
      pluginId={pluginId}
      selectedId={signal ?? null}
      onSelect={(signalId) => {
        // The selection replaces the history entry, so Back leaves Intake
        // rather than stepping through every row `J` passed.
        void navigate({
          search: {
            ...(view === undefined ? {} : { view }),
            ...(signalId === null ? {} : { signal: signalId }),
          },
          replace: true,
        });
      }}
      onViewChange={(next) => {
        // A view switch is a step of its own in the history, and starts with no selection.
        void navigate({ search: next === "to-do" ? {} : { view: next } });
      }}
      onPluginChange={setPluginId}
    />
  );
}
