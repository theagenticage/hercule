/**
 * Reads a Draft Thread, for the draft screen and for the sidebar's draft row.
 */
import { useSyncExternalStore } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildDraftView, type DraftAddress, type DraftView } from "@hercule/client-core";
import { buildDraftKey } from "./pending-submissions";
import {
  localRunnerQuery,
  profilesQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  settingsQuery,
  threadsQuery,
  workspacesQuery,
} from "./queries";

/**
 * Returns the Draft Thread at `address`. Returns `null` when `address` is
 * `null`, or while the settings or the profiles are not in the cache.
 *
 * The draft screen and the sidebar's draft row both read the draft here, so
 * both are built by `buildDraftView` from the same reads and the same picks.
 * The row names the workspace and the machine the screen's lip names, and
 * follows every pick the user makes on the screen. Only the picks are read
 * from the draft's pending submission: its text changes with every key the
 * user types, and the draft does not depend on it.
 *
 * The shell's loader reads the lists, so they are in the cache. The other
 * three reads run only while a draft is open, and never suspend, so a failed
 * one costs the sidebar only its draft row. The new-thread route's loader
 * reads all three before its screen shows, so the screen always finds them.
 * A later probe of the local runner, when the runners change, keeps the
 * previous answer until it returns.
 */
export function useDraftThread(address: DraftAddress | null): DraftView | null {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const open = address !== null;
  const settings = useQuery({ ...settingsQuery(client), enabled: open }).data;
  const profiles = useQuery({ ...profilesQuery(client), enabled: open }).data;
  const lists = {
    instances: useSuspenseQuery(providersQuery(client)).data,
    runners,
    thisMacRunnerId: useQuery({ ...localRunnerQuery(bridge, runners), enabled: open }).data ?? null,
    projects: useSuspenseQuery(projectsQuery(client)).data,
    resources: useSuspenseQuery(resourcesQuery(client)).data,
    workspaces: useSuspenseQuery(workspacesQuery(client)).data,
    sessions: useSuspenseQuery(threadsQuery(client)).data,
  };
  const key = buildDraftKey(address?.projectId ?? null, address?.workspaceId ?? null);
  const picks = useSyncExternalStore(
    pendingSubmissions.subscribe,
    () => pendingSubmissions.read(key).picks,
  );
  if (address === null || settings === undefined || profiles === undefined) return null;
  return buildDraftView({ ...lists, settings, profiles }, address, picks);
}
