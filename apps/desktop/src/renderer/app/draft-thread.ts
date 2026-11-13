/**
 * Reads a Draft Thread, for the draft screen and for the sidebar's draft row.
 */
import { useSyncExternalStore } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildDraftView,
  type DraftAddress,
  type DraftReads,
  type DraftView,
} from "@hercule/client-core";
import { buildDraftKey } from "./pending-submissions";
import { readRecentModels } from "./recent-models";
import {
  harnessesQuery,
  localRunnerQuery,
  modelProfilesQuery,
  profilesQuery,
  projectsQuery,
  providerAccountsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  settingsQuery,
  threadsQuery,
  workspacesQuery,
} from "./queries";

/**
 * Reads every record a Draft Thread is built from, for `buildDraftView`, and
 * returns them. Returns `null` while the settings or the profiles are not in
 * the cache, and while `isOpen` is false: then the reads that only a draft
 * needs are not made.
 *
 * The shell's loader reads the lists, so they are in the cache. The other
 * three reads run only while a draft is open, and never suspend, so a failed
 * one costs the sidebar only its draft row. A later probe of the local
 * runner, when the runners change, keeps the previous answer until it
 * returns.
 */
export function useDraftReads(isOpen: boolean): DraftReads | null {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const settings = useQuery({ ...settingsQuery(client), enabled: isOpen }).data;
  const profiles = useQuery({ ...profilesQuery(client), enabled: isOpen }).data;
  const lists = {
    accounts: useSuspenseQuery(providerAccountsQuery(client)).data,
    providers: useSuspenseQuery(providersQuery(client)).data,
    harnesses: useSuspenseQuery(harnessesQuery(client)).data,
    modelProfiles: useSuspenseQuery(modelProfilesQuery(client)).data,
    runners,
    thisMacRunnerId:
      useQuery({ ...localRunnerQuery(bridge, runners), enabled: isOpen }).data ?? null,
    projects: useSuspenseQuery(projectsQuery(client)).data,
    resources: useSuspenseQuery(resourcesQuery(client)).data,
    workspaces: useSuspenseQuery(workspacesQuery(client)).data,
    sessions: useSuspenseQuery(threadsQuery(client)).data,
  };
  if (!isOpen || settings === undefined || profiles === undefined) return null;
  return { ...lists, settings, profiles, recent: readRecentModels(controller.url) };
}

/**
 * Returns the Draft Thread at `address`. Returns `null` when `address` is
 * `null`, or while the settings or the profiles are not in the cache.
 *
 * The draft screen and the sidebar's draft row both read the draft here, so
 * both are built by `buildDraftView` from the same reads (`useDraftReads`) and
 * the same picks. The row names the workspace and the machine the screen's
 * lip names, and follows every pick the user makes on the screen. Only the
 * picks are read from the draft's pending submission: its text changes with
 * every key the user types, and the draft does not depend on it.
 */
export function useDraftThread(address: DraftAddress | null): DraftView | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { pendingSubmissions } = controller;
  const reads = useDraftReads(address !== null);
  const key = buildDraftKey(address?.projectId ?? null, address?.workspaceId ?? null);
  const picks = useSyncExternalStore(
    pendingSubmissions.subscribe,
    () => pendingSubmissions.read(key).picks,
  );
  if (address === null || reads === null) return null;
  return buildDraftView(reads, address, picks);
}
