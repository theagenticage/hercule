import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import {
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
 * The search params of Intake: the view shown, Later or Done, and the
 * selected signal, whose pane is open. With no `view`, Intake shows To do.
 */
export interface IntakeSearch {
  readonly view?: "later" | "done";
  readonly signal?: string;
}

/**
 * Returns Intake's search params from the URL's. A `view` that is not Later
 * or Done, and a `signal` that is not an id, are dropped.
 */
const validateIntakeSearch = (search: Record<string, unknown>): IntakeSearch => ({
  ...(search.view === "later" || search.view === "done" ? { view: search.view } : {}),
  ...(isId(search.signal) ? { signal: search.signal } : {}),
});

/**
 * Intake: the signals of one view, and the selected one in a pane (spec 17
 * §Intake).
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
 */
export const Route = createFileRoute("/_connected/_shell/intake")({
  staticData: { title: "Intake" },
  validateSearch: validateIntakeSearch,
  loaderDeps: ({ search }) => ({ signal: search.signal }),
  loader: async ({ context: { controller, queryClient }, deps, cause }) => {
    const { client } = controller;
    const opening = Promise.all([
      cause === "stay"
        ? queryClient.ensureQueryData(workflowsQuery(client))
        : readOnOpen(queryClient, workflowsQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsClearedTodayQuery(client)),
      queryClient.ensureInfiniteQueryData(signalsLaterQuery(client)),
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
  const { view, signal } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <IntakeScreen
      view={view ?? "to-do"}
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
    />
  );
}
