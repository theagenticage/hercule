import { Fragment, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, resolveDisplayTimezone } from "@hercule/client-core";
import { describeMachineActivity } from "@hercule/client-core/machine-activity";
import type { Runner } from "@hercule/contract";
import {
  machineRecentActivityQuery,
  providerAccountsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { ChevronRightIcon } from "../../../../icons/chevron-right";
import { MachineActivityNote } from "../../../../screens/fleet/machine-activity-head";
import {
  MachineActivityMemberRow,
  MachineActivityRow,
} from "../../../../screens/fleet/machine-activity-row";
import { MachinePageSection } from "../../../../screens/fleet/machine-page-section";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useOpenEntries } from "../../../../screens/fleet/use-open-entries";

/** The heading `describeMachineActivity` gives today's entries, which need no day before their time. */
const TODAY_HEADING = "Today";

/** How many entries the section lists before "All activity". */
const RECENT_ENTRY_COUNT = 5;

/**
 * Renders the Recent section of the machine `runner`'s page (spec 17 §Fleet,
 * A machine's page): its five newest activity entries, then "All activity",
 * which opens the Activity page.
 *
 * It reads the first page of the machine's audit log only, and describes it
 * with the filter "all". An entry that is not from today starts with its day,
 * because the section lists entries without day headings. An entry that
 * folded several log entries unfolds in place. The section is a few plain
 * lines, so it is not virtualized.
 *
 * A read that fails shows a line with a Retry in place of the entries, and
 * leaves the rest of the page as it is.
 */
export function MachineRecent({
  id,
  runner,
}: {
  readonly id: string;
  readonly runner: Runner;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const recent = useQuery(machineRecentActivityQuery(client, runner.id));
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // The section words each entry's day, so it watches for midnight whether the machine is online or not.
  const today = useFleetToday(timezone, true);
  const { openKeys, toggle } = useOpenEntries();

  const days = describeMachineActivity(recent.data?.items ?? [], {
    filter: "all",
    timezone,
    today,
    accounts,
  });
  const entries = days
    .flatMap((day) => day.entries.map((entry) => ({ entry, dayHeading: day.heading })))
    .slice(0, RECENT_ENTRY_COUNT);

  return (
    <MachinePageSection id={id} title="Recent">
      {recent.data === undefined ? (
        recent.isError ? (
          <MachineActivityNote onRetry={() => void recent.refetch()}>
            {`Couldn't read the activity. ${readErrorMessage(recent.error)}`}
          </MachineActivityNote>
        ) : null
      ) : entries.length === 0 ? (
        <p className="machine-activity-empty">{`Nothing has happened on ${runner.name} yet.`}</p>
      ) : (
        <>
          <div className="machine-activity machine-activity--recent">
            {entries.map(({ entry, dayHeading }, index) => {
              const isOpen = entry.members.length > 1 && openKeys.has(entry.key);
              return (
                <Fragment key={entry.key}>
                  <MachineActivityRow
                    entry={entry}
                    dayHeading={dayHeading === TODAY_HEADING ? undefined : dayHeading}
                    joinsAbove={index > 0}
                    isOpen={isOpen}
                    onToggle={() => toggle(entry.key)}
                  />
                  {isOpen &&
                    entry.members.map((member) => (
                      <MachineActivityMemberRow key={member.eventId} member={member} />
                    ))}
                </Fragment>
              );
            })}
          </div>
          <Link
            to="/fleet/$runnerId/activity"
            params={{ runnerId: runner.id }}
            className="machine-activity-all"
          >
            All activity
            <ChevronRightIcon size={12} />
          </Link>
        </>
      )}
    </MachinePageSection>
  );
}
