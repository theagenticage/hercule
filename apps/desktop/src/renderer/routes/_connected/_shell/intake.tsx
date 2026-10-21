import { Suspense, lazy, useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  EVENT_HANDLINGS,
  isId,
  MAX_EVENT_SOURCE_LENGTH,
  MAX_SEARCH_TEXT_LENGTH,
  type EventHandling,
} from "@hercule/contract";
import { computeEventHorizonStart } from "@hercule/client-core";
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
import { IntakeScreen } from "../../../screens/intake/intake-screen";

/**
 * Everything's screen, loaded the first time the view opens, so its code
 * stays out of Intake's chunk (spec 17 §Performance).
 */
const loadEverythingScreen = () => import("../../../screens/intake/everything-screen");
const EverythingScreen = lazy(() =>
  loadEverythingScreen().then((module) => ({ default: module.EverythingScreen })),
);

/**
 * The search params of Intake:
 *
 * - `view`: the view shown, Later, Done or Everything. With none, Intake shows To do.
 * - `signal`: the selected signal, whose pane is open, on To do, Later and Done.
 * - `tracking`: set while Tracking is opened over the To do list. It lives in
 *   the address so that coming back from a run's page or a thread, which the
 *   pane of a Tracking row opens, finds Tracking open again.
 * - `task`: the selected row of opened Tracking, whose pane is open. It lives
 *   in the address for the same reason, so coming back finds the same row.
 * - `event`: the selected event, whose pane is open, on Everything.
 * - `text`, `handling` and `source`: Everything's search, filter and source tab. With none, every event shows.
 *
 * A param may be `undefined` in a search a caller builds, which removes it from the URL.
 */
export interface IntakeSearch {
  readonly view?: "later" | "done" | "everything" | undefined;
  readonly signal?: string | undefined;
  readonly tracking?: true | undefined;
  readonly task?: string | undefined;
  readonly event?: number | undefined;
  readonly text?: string | undefined;
  readonly handling?: EventHandling | undefined;
  readonly source?: string | undefined;
}

/** Checks whether `value` is a handling the controller can filter events on. */
const isEventHandling = (value: unknown): value is EventHandling =>
  EVENT_HANDLINGS.some((handling) => handling === value);

/** Checks whether `value` is a non-empty string of at most `maxLength` characters. */
const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value !== "" && value.length <= maxLength;

/**
 * Returns Intake's search params from the URL's. A `view` that is not Later,
 * Done or Everything, a `signal` or a `task` that is not an id, a `tracking`
 * that is not `true`, an `event` that is not a whole number from 1, a `text` or a `source` that is empty or too long, and a
 * `handling` that is not one the controller filters on are dropped.
 *
 * A dropped param is returned as `undefined` rather than left out, because
 * the router lays the returned params over the URL's: a param left out
 * would keep the URL's value.
 */
const validateIntakeSearch = (search: Record<string, unknown>): IntakeSearch => ({
  view:
    search.view === "later" || search.view === "done" || search.view === "everything"
      ? search.view
      : undefined,
  signal: isId(search.signal) ? search.signal : undefined,
  tracking: search.tracking === true ? true : undefined,
  task: isId(search.task) ? search.task : undefined,
  event:
    typeof search.event === "number" && Number.isSafeInteger(search.event) && search.event >= 1
      ? search.event
      : undefined,
  text: isBoundedText(search.text, MAX_SEARCH_TEXT_LENGTH) ? search.text : undefined,
  handling: isEventHandling(search.handling) ? search.handling : undefined,
  source: isBoundedText(search.source, MAX_EVENT_SOURCE_LENGTH) ? search.source : undefined,
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
 * The loader reads nothing for the selected row of Tracking. Its pane's head
 * and answers need no read, and the pane reads the Task's trip itself when it
 * mounts, so the trip draws when that read arrives. Stepping through the rows
 * with `J` while the pane is hidden therefore sends no request.
 *
 * On Everything, the loader reads the first page of events for the search,
 * the filter and the source tab in the URL, back to the horizon the
 * controller's retention reaches, and loads the screen's code. No live push
 * keeps the events current, so each time the view opens, or the search, the
 * filter or the tab changes, the listing starts again from its first page: a
 * listing already held shows its first page at once and is refreshed behind.
 * The loader returns the moment it ran, which the screen takes as "now" for
 * as long as that listing stays. The selected event is not part of what the
 * loader depends on, so `J` and `K` send no request.
 *
 * On To do, Later and Done the pressed source tab is state of this route,
 * not the URL's, and ends with the window. On Everything it is the URL's
 * `source`. Moving between the views carries the tab over.
 */
export const Route = createFileRoute("/_connected/_shell/intake")({
  staticData: { title: "Intake" },
  validateSearch: validateIntakeSearch,
  loaderDeps: ({ search }) => ({
    view: search.view,
    signal: search.signal,
    text: search.text,
    handling: search.handling,
    source: search.source,
  }),
  loader: async ({ context: { controller, queryClient }, deps, cause }) => {
    const { client } = controller;
    const openedAt = Date.now();
    const settings = await queryClient.ensureQueryData(settingsQuery(client));
    const opening = Promise.all([
      cause === "stay"
        ? queryClient.ensureQueryData(workflowsQuery(client))
        : readOnOpen(queryClient, workflowsQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsClearedTodayQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsLaterQuery(client)),
      deps.view === "everything"
        ? Promise.all([
            readInfiniteOnOpen(
              queryClient,
              eventsEverythingQuery(
                client,
                { text: deps.text, source: deps.source, handling: deps.handling },
                computeEventHorizonStart(
                  new Date(openedAt),
                  settings.controller?.["retention.events"],
                ),
              ),
            ),
            loadEverythingScreen(),
          ])
        : undefined,
    ]);
    if (deps.signal === undefined) {
      await opening;
      return { openedAt };
    }
    const listed = queryClient
      .getQueryData(signalsToDoQuery(client).queryKey)
      ?.some((signal) => signal.id === deps.signal);
    const read = queryClient.prefetchQuery(signalQuery(client, deps.signal));
    await Promise.all([opening, listed === true ? undefined : read]);
    return { openedAt };
  },
  component: IntakeRoute,
});

function IntakeRoute(): JSX.Element {
  const { view, signal, tracking, task, event, text, handling, source } = Route.useSearch();
  const { openedAt } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const [pluginId, setPluginId] = useState<string | null>(null);
  if (view === "everything") {
    return (
      // Nothing is drawn while the screen's code loads, which the loader has
      // already started, so this is a wait for the first opening only.
      <Suspense fallback={null}>
        <EverythingScreen
          pluginId={source ?? null}
          text={text ?? ""}
          handling={handling ?? null}
          selectedId={event ?? null}
          openedAt={openedAt}
          onSelect={(eventId) => {
            // As on the signal views, the selection replaces the history entry.
            void navigate({
              search: (previous) => ({ ...previous, event: eventId ?? undefined }),
              replace: true,
            });
          }}
          onSearchChange={(next) => {
            // A search, a filter or a tab starts a new list, so the selection
            // goes; the history entry is replaced, so Back leaves Intake rather
            // than stepping through every pause in typing.
            void navigate({
              search: (previous) => ({
                ...previous,
                text: next === "" ? undefined : next,
                event: undefined,
              }),
              replace: true,
            });
          }}
          onHandlingChange={(next) => {
            void navigate({
              search: (previous) => ({
                ...previous,
                handling: next ?? undefined,
                event: undefined,
              }),
              replace: true,
            });
          }}
          onPluginChange={(next) => {
            void navigate({
              search: (previous) => ({ ...previous, source: next ?? undefined, event: undefined }),
              replace: true,
            });
          }}
          onViewChange={(next) => {
            // The tab goes with the user to the other views, which keep it in
            // this route's state.
            setPluginId(source ?? null);
            void navigate({ search: next === "to-do" ? {} : { view: next } });
          }}
        />
      </Suspense>
    );
  }
  return (
    <IntakeScreen
      view={view ?? "to-do"}
      pluginId={pluginId}
      selectedId={signal ?? null}
      trackingOpen={tracking === true}
      selectedTaskId={task ?? null}
      onTrackingOpenChange={(open, taskId) => {
        // Opening Tracking covers the list, so the selected signal goes with it,
        // and closing it takes its selected row away. Like the selection, it
        // replaces the history entry.
        void navigate({
          search: (previous) => ({
            ...previous,
            tracking: open ? true : undefined,
            task: open ? taskId : undefined,
            signal: open ? undefined : previous.signal,
          }),
          replace: true,
        });
      }}
      onSelectTask={(taskId) => {
        void navigate({
          search: (previous) => ({ ...previous, task: taskId ?? undefined }),
          replace: true,
        });
      }}
      onOpenDestination={(destination) => {
        switch (destination.kind) {
          case "run":
            void navigate({ to: "/runs/$runId", params: { runId: destination.runId } });
            return;
          case "thread":
            void navigate({
              to: "/threads/$sessionId",
              params: { sessionId: destination.sessionId },
            });
            return;
          case "signal":
            // The signal may be on a tab other than the one pressed, so the tab goes back to All,
            // where every signal of To do is listed. Closing Tracking and selecting the signal are
            // one step, replacing the history entry as a selection does.
            setPluginId(null);
            void navigate({
              search: (previous) => ({
                ...previous,
                tracking: undefined,
                task: undefined,
                signal: destination.signalId,
              }),
              replace: true,
            });
            return;
        }
      }}
      onSelect={(signalId) => {
        // The selection replaces the history entry, so Back leaves Intake
        // rather than stepping through every row `J` passed.
        void navigate({
          search: (previous) => ({ ...previous, signal: signalId ?? undefined }),
          replace: true,
        });
      }}
      onViewChange={(next) => {
        // A view switch is a step of its own in the history, and starts with no selection.
        void navigate({
          search:
            next === "everything"
              ? { view: next, source: pluginId ?? undefined }
              : next === "to-do"
                ? {}
                : { view: next },
        });
      }}
      onPluginChange={setPluginId}
    />
  );
}
