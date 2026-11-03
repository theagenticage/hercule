import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { decideMachineKind } from "@hercule/client-core/fleet";
import type { Runner } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  machineActivityQuery,
  providerAccountsQuery,
  readInfiniteOnOpen,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader } from "../../../../screens/fleet/fleet-header";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { MachineActivityHistory } from "./-machine-activity-history";
import { RunnerNotFound } from "./-runner-not-found";

/**
 * One machine's activity (spec 17 §Fleet, Activity): what the controller's
 * audit log recorded about the machine, by day, newest first, with filters.
 *
 * The page is a route of its own, beside the machine's page and not inside
 * it, so its loader reads only what the page draws: the first page of the
 * log (started afresh on each opening, see `readInfiniteOnOpen`), the
 * runners, the Provider Accounts that name an account in a sentence, and the
 * settings, whose time zone the times are shown in. When no runner has the
 * id, or the runner is retired, it shows the same screen as the machine's
 * page.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/$runnerId_/activity")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient }, params: { runnerId }, location }) => {
    const { client } = controller;
    const [runners] = await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
      readInfiniteOnOpen(queryClient, machineActivityQuery(client, runnerId)),
    ]);
    if (!runners.some((runner) => runner.id === runnerId && runner.lifecycle !== "retired")) {
      throwScreenNotFound(location);
    }
  },
  component: MachineActivityPage,
  notFoundComponent: RunnerNotFound,
});

/** Draws the machine's activity, or `RunnerNotFound` when the machine was retired or removed while the page was open. */
function MachineActivityPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { runnerId } = Route.useParams();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const runner = runners.find((each) => each.id === runnerId && each.lifecycle !== "retired");
  return runner === undefined ? <RunnerNotFound /> : <MachineActivityFrame runner={runner} />;
}

/**
 * Draws the Fleet header over the activity of the machine `runner`, with the
 * history in the Fleet scroll area. Add a machine is held here, because the
 * header offers it on every Fleet page.
 */
function MachineActivityFrame({ runner }: { readonly runner: Runner }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { data: settings } = useSuspenseQuery(settingsQuery(controller.client));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAdding, setAdding] = useState(false);

  return (
    <>
      <FleetHeader
        place={{
          page: "activity",
          runnerId: runner.id,
          machine: { name: runner.name, kind: decideMachineKind(runner.facts) },
        }}
        onAddMachine={() => setAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <MachineActivityHistory
          runnerId={runner.id}
          machineName={runner.name}
          scrollRef={scrollRef}
        />
      </FleetScroll>
      {isAdding && (
        <AddMachineDialog
          client={controller.client}
          origin={controller.url}
          timezone={resolveDisplayTimezone(settings.user.timezone)}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
