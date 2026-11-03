import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { describeMachinePage } from "@hercule/client-core/machine-page";
import type { Runner } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  providerAccountsQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader } from "../../../../screens/fleet/fleet-header";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { MachinePageBanner } from "../../../../screens/fleet/machine-page-banner";
import { MachinePageHead, MachinePageRoomLine } from "../../../../screens/fleet/machine-page-head";
import { MachinePageInstruments } from "../../../../screens/fleet/machine-page-instruments";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useSectionInView } from "../../../../screens/fleet/use-section-in-view";
import { NotFound } from "../../../../screens/not-found";
import { MachineRetireDialog } from "./-machine-retire-dialog";
import { MachineSettings } from "./-machine-settings";
import { MachineSoftware } from "./-machine-software";
import { useRunnerSessionCounts } from "./-session-counts";

/** The ids of the page's sections, which the header's jump links scroll to. */
const CAPACITY_ID = "machine-capacity";
const SOFTWARE_ID = "machine-software";
const SETTINGS_ID = "machine-settings";
const SECTION_IDS = [CAPACITY_ID, SOFTWARE_ID, SETTINGS_ID];
const SECTIONS = [
  { id: CAPACITY_ID, label: "Capacity" },
  { id: SOFTWARE_ID, label: "Software" },
  { id: SETTINGS_ID, label: "Settings" },
];

/**
 * One machine's page (spec 17 §Fleet, A machine's page): its head and room
 * line, or the banner of a machine that is away, then its instruments, its
 * Software and its Settings. Its loader reads everything the page draws before it renders, as
 * the Fleet page's does (`fleet/index.tsx`). When no runner has the id, or the
 * runner is retired, the route shows `RunnerNotFound`: retired machines are
 * not shown anywhere on Fleet.
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
      readOnOpen(queryClient, settingsQuery(client)),
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

/** Draws the machine's page, or `RunnerNotFound` when the machine was retired or removed while its page was open. */
function MachinePage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { runnerId } = Route.useParams();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const runner = runners.find((each) => each.id === runnerId && each.lifecycle !== "retired");
  return runner === undefined ? <RunnerNotFound /> : <MachineFrame runner={runner} />;
}

/**
 * Draws the Fleet header over the page of the machine `runner`, and the page
 * in the Fleet scroll area. The head, its line and the instruments are drawn
 * here from what the page already holds; the Software and Settings sections
 * read what they draw themselves.
 *
 * Retire… on the banner and in Settings ask the same question, so the dialog
 * is held here. So is Add a machine, which the header offers on every Fleet
 * page.
 */
function MachineFrame({ runner }: { readonly runner: Runner }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const sessionCounts = useRunnerSessionCounts(client);
  const { data: controllerRecord } = useSuspenseQuery(controllerQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const scrollRef = useRef<HTMLDivElement>(null);
  const { activeSectionId, scrollToSection } = useSectionInView(scrollRef, SECTION_IDS);
  const [isRetiring, setRetiring] = useState(false);
  const [isAdding, setAdding] = useState(false);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const today = useFleetToday(timezone, runner.connectivity !== "online");
  const page = describeMachinePage(
    runner,
    sessionCounts,
    controllerRecord.version,
    timezone,
    today,
  );

  return (
    <>
      <FleetHeader
        place={{ page: "machine", machine: { name: page.head.name, kind: page.head.kind } }}
        sections={SECTIONS}
        activeSectionId={activeSectionId}
        onJump={scrollToSection}
        onAddMachine={() => setAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <div className="machine-page">
          <MachinePageHead runnerId={runner.id} head={page.head} />
          {page.top.kind === "away" && (
            <MachinePageBanner banner={page.top.banner} onRetire={() => setRetiring(true)} />
          )}
          {/* The section has no visible heading: the room line and the numbers
              need none. Its label names it for the jump link and for screen readers. */}
          <section id={CAPACITY_ID} className="machine-page-capacity" aria-label="Capacity">
            {page.top.kind === "room" && <MachinePageRoomLine line={page.top.line} />}
            <MachinePageInstruments
              instruments={page.instruments}
              isAway={page.top.kind === "away"}
            />
          </section>
          <MachineSoftware id={SOFTWARE_ID} runner={runner} />
          <MachineSettings id={SETTINGS_ID} runner={runner} onRetire={() => setRetiring(true)} />
        </div>
      </FleetScroll>
      {isRetiring && (
        <MachineRetireDialog
          runner={runner}
          defaultRunnerId={controllerRecord.defaultRunnerId}
          onClose={() => setRetiring(false)}
        />
      )}
      {isAdding && (
        <AddMachineDialog
          client={client}
          origin={controller.url}
          timezone={timezone}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
