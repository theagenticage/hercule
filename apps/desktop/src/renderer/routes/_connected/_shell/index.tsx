import type { JSX } from "react";
import type { EnsureQueryDataOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { buildDraftKey } from "../../../app/pending-submissions";
import {
  localRunnerQuery,
  profilesQuery,
  runnersQuery,
  settingsQuery,
  startTasksQuery,
} from "../../../app/queries";
import { DraftScreen } from "../../../screens/new-thread/draft-screen";

/**
 * The search params of a new thread: the project it belongs to, and the
 * workspace it joins. The project picker, a project's `+` and a workspace
 * label's `+` in the sidebar set them.
 */
export interface NewThreadSearch {
  readonly project?: string;
  readonly workspace?: string;
}

/**
 * Returns the new thread's search params from the URL's. A param that is not
 * an id is dropped, so the screen never acts on a malformed link.
 */
const validateNewThreadSearch = (search: Record<string, unknown>): NewThreadSearch => ({
  ...(isId(search.project) ? { project: search.project } : {}),
  ...(isId(search.workspace) ? { workspace: search.workspace } : {}),
});

/**
 * The screen the app starts on, when no thread is open: a Draft Thread, in
 * the project and joining the workspace the search params name.
 *
 * Its loader finds which runner is on this Mac before the screen renders.
 * The shell's loader reads everything else the draft is built from, but the
 * router runs the two loaders side by side, so this one reads the runners
 * itself before it probes them. The project's start cards are only
 * prefetched: the draft does not wait for them.
 *
 * The settings and the profiles are read again each time the screen opens,
 * because no live push says when they change, see `readOnOpen`.
 */
export const Route = createFileRoute("/_connected/_shell/")({
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
  staticData: { title: "New thread" },
  validateSearch: validateNewThreadSearch,
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ context: { bridge, controller, queryClient }, deps }) => {
    const { client } = controller;
    if (deps.project !== undefined) {
      void queryClient.prefetchQuery(startTasksQuery(client, deps.project));
    }
    const probeLocalRunner = async (): Promise<void> => {
      const runners = await queryClient.ensureQueryData(runnersQuery(client));
      await queryClient.ensureQueryData(localRunnerQuery(bridge, runners));
    };
    await Promise.all([
      readOnOpen(queryClient, settingsQuery(client)),
      readOnOpen(queryClient, profilesQuery(client)),
      probeLocalRunner(),
    ]);
  },
  component: NewThreadRoute,
});

/**
 * Reads `options` once for this opening of the screen, and returns its data.
 *
 * The first time, there is nothing to show, so the screen waits for the
 * read. After that, the data read last is returned at once and the read runs
 * in the background, so opening a draft waits on the controller only the
 * first time. The data never goes stale on its own, so marking it out of
 * date here is what makes it read again. A component that starts reading it
 * while that read runs joins it rather than sending a second one.
 */
const readOnOpen = <Data,>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<Data, Error, Data, QueryKey>,
): Promise<Data> => {
  void queryClient.invalidateQueries({ queryKey: options.queryKey, refetchType: "none" });
  return queryClient.ensureQueryData({ ...options, revalidateIfStale: true });
};

function NewThreadRoute(): JSX.Element {
  const search = Route.useSearch();
  const projectId = search.project ?? null;
  const workspaceId = search.workspace ?? null;
  // Keyed by the draft's place, so another place starts with fresh state: its
  // own draft, and no error left from a failed start elsewhere.
  return (
    <DraftScreen
      key={buildDraftKey(projectId, workspaceId)}
      projectId={projectId}
      workspaceId={workspaceId}
    />
  );
}
