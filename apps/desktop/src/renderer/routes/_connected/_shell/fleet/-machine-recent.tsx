import { Fragment, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, resolveDisplayTimezone } from "@hercule/client-core";
import {
  describeEmptyMachineActivity,
  describeRecentMachineActivity,
} from "@hercule/client-core/machine-activity";
import type { Runner } from "@hercule/contract";
import {
  machineRecentActivityQuery,
  providerAccountsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { ChevronRightIcon } from "../../../../icons/chevron-right";
import { MachineActivityNote } from "../../../../screens/fleet/machine-activity-note";
import {
  MachineActivityMemberRow,
  MachineActivityRow,
} from "../../../../screens/fleet/machine-activity-row";
import { MachinePageSection } from "../../../../screens/fleet/machine-page-section";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useOpenEntries } from "../../../../screens/fleet/use-open-entries";

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
 * "All activity" is there in every state, so the Activity page is always one
 * press away. A read that fails shows a line with a Retry, under the entries
 * when an earlier read left some, and leaves the rest of the page as it is.
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

  const entries = describeRecentMachineActivity(recent.data?.items ?? [], {
    timezone,
    today,
    accounts,
  });

  const failed =
    recent.data === undefined ? "Couldn't read the activity." : "Couldn't refresh the activity.";

  return (
    <MachinePageSection id={id} title="Recent" note="From the controller's audit log">
      {entries.length > 0 && (
        <div className="machine-activity machine-activity--recent">
          {entries.map((entry, index) => {
            const isOpen = entry.members.length > 1 && openKeys.has(entry.key);
            return (
              <Fragment key={entry.key}>
                <MachineActivityRow
                  entry={entry}
                  dayHeading={entry.day}
                  joinsAbove={index > 0}
                  isOpen={isOpen}
                  onToggle={() => toggle(entry.key)}
                />
                {isOpen &&
                  entry.members.map((member, memberIndex) => (
                    <MachineActivityMemberRow
                      key={member.eventId}
                      member={member}
                      isLast={memberIndex === entry.members.length - 1}
                    />
                  ))}
              </Fragment>
            );
          })}
        </div>
      )}
      {recent.data !== undefined && entries.length === 0 && (
        <p className="machine-activity-empty">{describeEmptyMachineActivity("all", runner.name)}</p>
      )}
      {recent.isError && (
        <MachineActivityNote onRetry={() => void recent.refetch()}>
          {`${failed} ${readErrorMessage(recent.error)}`}
        </MachineActivityNote>
      )}
      <Link
        to="/fleet/$runnerId/activity"
        params={{ runnerId: runner.id }}
        className="machine-activity-all"
      >
        All activity
        <ChevronRightIcon size={12} />
      </Link>
    </MachinePageSection>
  );
}
