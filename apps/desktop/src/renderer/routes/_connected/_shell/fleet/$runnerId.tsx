import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  providerAccountsQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
} from "../../../../app/queries";
import { NotFound } from "../../../../screens/not-found";

/**
 * One machine's page (spec 17 §Fleet). Its loader reads everything the page
 * draws before it renders, as the Fleet page's does (`fleet/index.tsx`). When
 * no runner has the id, or the runner is retired, the route shows
 * `RunnerNotFound`: retired machines are not shown anywhere on Fleet.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/$runnerId")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient }, params: { runnerId }, location }) => {
    const { client } = controller;
    const [runners] = await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.ensureQueryData(harnessesQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.fetchQuery(fleetSessionsQuery(client)),
      readOnOpen(queryClient, controllerQuery(client)),
    ]);
    if (!runners.some((runner) => runner.id === runnerId && runner.lifecycle !== "retired")) {
      throwScreenNotFound(location);
    }
  },
  component: MachinePage,
  notFoundComponent: RunnerNotFound,
});

/** Renders the screen of a machine that does not exist or is retired, with a link back to Fleet. */
function RunnerNotFound(): JSX.Element {
  return (
    <NotFound headline="This machine was not found.">
      <Link to="/fleet" className="btn btn--accent">
        Fleet
      </Link>
    </NotFound>
  );
}

/**
 * Draws the machine's name, or `RunnerNotFound` when the machine was retired
 * or removed while its page was open.
 */
function MachinePage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { runnerId } = Route.useParams();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const runner = runners.find((each) => each.id === runnerId && each.lifecycle !== "retired");
  return runner === undefined ? <RunnerNotFound /> : <h1>{runner.name}</h1>;
}
