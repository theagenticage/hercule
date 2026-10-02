import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FirstRunReads, FirstRunStep, HerculeClient } from "@hercule/client-core";
import type { Assistant } from "@hercule/contract";
import type { Bridge } from "../../../ipc/bridge";
import {
  assistantsQuery,
  connectionsQuery,
  controllerQuery,
  firstRunQuery,
  projectsQuery,
  providersQuery,
  runnersQuery,
} from "../../app/queries";

/** What the first run reads to decide its step and to furnish its room. */
export interface FirstRunData {
  readonly reads: FirstRunReads;
  readonly assistants: readonly Assistant[];
  /** The steps the user put off, from main's first-run record. */
  readonly putOff: readonly FirstRunStep[];
}

const NONE: readonly never[] = [];

/**
 * Returns what the first run reads, from the query cache. Before the user
 * has an account (`signedIn` false), the controller answers none of these
 * reads, so the data is empty and setup is not complete.
 *
 * The result keeps its identity while no read changes, because the room is
 * built from it and the room compares its contents by identity.
 *
 * The route's loader, or the account step after setup, reads every query
 * first, so none of them waits here.
 */
export const useFirstRunData = (
  client: HerculeClient,
  bridge: Bridge,
  signedIn: boolean,
): FirstRunData => {
  const enabled = signedIn;
  const controller = useQuery({ ...controllerQuery(client), enabled }).data;
  const runners = useQuery({ ...runnersQuery(client), enabled }).data;
  const instances = useQuery({ ...providersQuery(client), enabled }).data;
  const connections = useQuery({ ...connectionsQuery(client), enabled }).data;
  const projects = useQuery({ ...projectsQuery(client), enabled }).data;
  const assistants = useQuery({ ...assistantsQuery(client), enabled }).data;
  const progress = useQuery({ ...firstRunQuery(bridge), enabled }).data;

  return useMemo(
    () => ({
      reads: {
        setupComplete: signedIn,
        localRunner: runners?.find((runner) => runner.id === controller?.localRunnerId) ?? null,
        instances: instances ?? NONE,
        connections: connections ?? NONE,
        projects: projects ?? NONE,
      },
      assistants: assistants ?? NONE,
      putOff: progress?.putOff ?? NONE,
    }),
    [signedIn, controller, runners, instances, connections, projects, assistants, progress],
  );
};
