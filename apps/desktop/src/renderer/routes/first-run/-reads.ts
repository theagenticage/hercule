import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { FirstRunReads, FirstRunStep, HerculeClient } from "@hercule/client-core";
import type {
  Assistant,
  Connection,
  ControllerInfo,
  Project,
  ProviderInstance,
  Runner,
} from "@hercule/contract";
import type { Bridge } from "../../../ipc/bridge";
import type { FirstRunProgress } from "../../../ipc/contract";
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

/** The first run's reads as they sit in the query cache, each undefined while it has no data. */
interface CachedFirstRunReads {
  readonly signedIn: boolean;
  readonly controller: ControllerInfo | undefined;
  readonly runners: readonly Runner[] | undefined;
  readonly instances: readonly ProviderInstance[] | undefined;
  readonly connections: readonly Connection[] | undefined;
  readonly projects: readonly Project[] | undefined;
  readonly assistants: readonly Assistant[] | undefined;
  readonly progress: FirstRunProgress | null | undefined;
}

const NONE: readonly never[] = [];

/** Builds the first run's data from its cached reads, with an empty list for each read that has no data. */
const buildFirstRunData = (cached: CachedFirstRunReads): FirstRunData => ({
  reads: {
    setupComplete: cached.signedIn,
    localRunner:
      cached.runners?.find((runner) => runner.id === cached.controller?.localRunnerId) ?? null,
    instances: cached.instances ?? NONE,
    connections: cached.connections ?? NONE,
    projects: cached.projects ?? NONE,
  },
  assistants: cached.assistants ?? NONE,
  putOff: cached.progress?.putOff ?? NONE,
});

/**
 * Returns what the first run reads, from the query cache, and renders again
 * when any of it changes. Before the user has an account (`signedIn` false),
 * the controller answers none of these reads, so the data is empty and setup
 * is not complete.
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
  // The controller answers none of these reads before the user has an account.
  const enabled = signedIn;
  const controller = useQuery({ ...controllerQuery(client), enabled }).data;
  const runners = useQuery({ ...runnersQuery(client), enabled }).data;
  const instances = useQuery({ ...providersQuery(client), enabled }).data;
  const connections = useQuery({ ...connectionsQuery(client), enabled }).data;
  const projects = useQuery({ ...projectsQuery(client), enabled }).data;
  const assistants = useQuery({ ...assistantsQuery(client), enabled }).data;
  const progress = useQuery({ ...firstRunQuery(bridge), enabled }).data;

  return useMemo(
    () =>
      buildFirstRunData({
        signedIn,
        controller,
        runners,
        instances,
        connections,
        projects,
        assistants,
        progress,
      }),
    [signedIn, controller, runners, instances, connections, projects, assistants, progress],
  );
};

/**
 * Returns what the first run reads, signed in, from the query cache as it is
 * now. An event handler calls it to decide the next step, because the data a
 * render captured can be older than the cache by then.
 */
export const readFirstRunData = (
  queryClient: QueryClient,
  client: HerculeClient,
  bridge: Bridge,
): FirstRunData =>
  buildFirstRunData({
    signedIn: true,
    controller: queryClient.getQueryData(controllerQuery(client).queryKey),
    runners: queryClient.getQueryData(runnersQuery(client).queryKey),
    instances: queryClient.getQueryData(providersQuery(client).queryKey),
    connections: queryClient.getQueryData(connectionsQuery(client).queryKey),
    projects: queryClient.getQueryData(projectsQuery(client).queryKey),
    assistants: queryClient.getQueryData(assistantsQuery(client).queryKey),
    progress: queryClient.getQueryData(firstRunQuery(bridge).queryKey),
  });
