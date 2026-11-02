import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  providerAccountsQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
} from "../../../../app/queries";

/**
 * Fleet: every machine at a glance (spec 17 §Fleet). Its loader reads
 * everything the page draws before it renders:
 *
 * - the runners, the harnesses, the providers and the Provider Accounts,
 *   which the shell reads and keeps current, so they are cached already;
 * - every session that has not exited, which a push on the `session` topic
 *   keeps current while Fleet is open. `fetchQuery` reads it again on open
 *   only when a push marked the cached read out of date while Fleet was
 *   closed;
 * - the controller's record, whose `localRunnerId` the page needs when the
 *   fleet is empty. No topic covers it, so it is read each time the page opens.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.ensureQueryData(harnessesQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.fetchQuery(fleetSessionsQuery(client)),
      readOnOpen(queryClient, controllerQuery(client)),
    ]);
  },
  component: FleetPage,
});

/** Draws the name of each machine that is not retired. */
function FleetPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  return (
    <ul>
      {runners
        .filter((runner) => runner.lifecycle !== "retired")
        .map((runner) => (
          <li key={runner.id}>{runner.name}</li>
        ))}
    </ul>
  );
}
