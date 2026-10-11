import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { signalQuery, signalsToDoQuery } from "../../../app/queries";
import { IntakeScreen } from "../../../screens/intake/intake-screen";

/** The search params of Intake: the selected signal, whose pane is open. */
export interface IntakeSearch {
  readonly signal?: string;
}

/** Returns Intake's search params from the URL's. A `signal` that is not an id is dropped. */
const validateIntakeSearch = (search: Record<string, unknown>): IntakeSearch =>
  isId(search.signal) ? { signal: search.signal } : {};

/**
 * Intake: the signals on To do, and the selected one in a pane (spec 17
 * §Intake).
 *
 * The route is split into a chunk of its own, so Intake's code loads the
 * first time it opens, never at the app's first paint. The shell's loader
 * has already read To do and the plugins. The loader reads the selected
 * signal:
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
  loader: async ({ context: { controller, queryClient }, deps }) => {
    if (deps.signal === undefined) return;
    const { client } = controller;
    const listed = queryClient
      .getQueryData(signalsToDoQuery(client).queryKey)
      ?.some((signal) => signal.id === deps.signal);
    const read = queryClient.prefetchQuery(signalQuery(client, deps.signal));
    if (listed !== true) await read;
  },
  component: IntakeRoute,
});

function IntakeRoute(): JSX.Element {
  const { signal } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <IntakeScreen
      selectedId={signal ?? null}
      onSelect={(signalId) => {
        // The selection replaces the history entry, so Back leaves Intake
        // rather than stepping through every row `J` passed.
        void navigate({ search: signalId === null ? {} : { signal: signalId }, replace: true });
      }}
    />
  );
}
