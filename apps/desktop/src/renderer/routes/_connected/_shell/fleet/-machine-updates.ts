import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { listFleetRunners } from "@hercule/client-core/fleet";
import { describeMachineUpdates } from "@hercule/client-core/software";
import { controllerQuery, harnessesQuery, runnersQuery } from "../../../../app/queries";

/**
 * Returns the quiet "2 updates" line of each machine, by runner id, for the
 * Fleet page's cards and rows. A machine with no update has no entry.
 *
 * The lines are built in the runners' `select`. TanStack Query keeps the
 * identity of a selected result that is equal to the last one, so the metrics
 * nudge that reads the runners again every minute redraws no card unless a
 * machine's line changed.
 */
export function useMachineUpdates(client: HerculeClient): Readonly<Record<string, string>> {
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const controllerVersion = useSuspenseQuery({
    ...controllerQuery(client),
    select: (record) => record.version,
  }).data;
  return useSuspenseQuery({
    ...runnersQuery(client),
    select: (runners) => {
      const lines: Record<string, string> = {};
      for (const runner of listFleetRunners(runners)) {
        const line = describeMachineUpdates(runner, harnesses, controllerVersion);
        if (line !== null) lines[runner.id] = line;
      }
      return lines;
    },
  }).data;
}
