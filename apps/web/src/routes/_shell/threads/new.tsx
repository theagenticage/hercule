import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { buildSiblingTabs, computeThreadDefaults } from "@hercule/client-core";
import {
  localRunnerQuery,
  profilesQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  settingsQuery,
  workspacesQuery,
} from "../../../app/queries";
import { Composer } from "../../../screens/composer/composer";
import { ThreadChrome, ThreadColumn } from "../../../screens/thread/thread-chrome";

/** The search params of a draft: the project it belongs to, and the workspace it joins. */
interface DraftSearch {
  readonly project?: string;
  readonly workspace?: string;
}

/**
 * The draft thread screen (spec 14 §The composer): "Creating a thread is one
 * step, after the project."
 *
 * This is a static route, so `/threads/new` must match it and not the param
 * route beside it (`$sessionId.tsx`), which would read "new" as a session id.
 * TanStack Router ranks a static segment above a param segment by itself.
 *
 * The project picker, a project's `+` and a workspace's `+` all open this
 * route. Only the URL search params record which project and workspace the
 * draft belongs to.
 */
export const Route = createFileRoute("/_shell/threads/new")({
  staticData: { title: "New thread", ownsTopBar: true },
  validateSearch: (search: Record<string, unknown>): DraftSearch => ({
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(typeof search.workspace === "string" ? { workspace: search.workspace } : {}),
  }),
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
      context.queryClient.ensureQueryData(settingsQuery(context.client)),
      // The lists the workspace menu reads. They are prefetched rather than
      // ensured: if the controller cannot list them, the draft has no project
      // to choose from. The composer then offers fewer choices, but the screen
      // still works.
      context.queryClient.prefetchQuery(projectsQuery(context.client)),
      context.queryClient.prefetchQuery(resourcesQuery(context.client)),
      context.queryClient.prefetchQuery(workspacesQuery(context.client)),
      context.queryClient.prefetchQuery(sessionsQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: NewThread,
});

function NewThread(): JSX.Element {
  const { client, detectLocalRunner } = Route.useRouteContext();
  const search = Route.useSearch();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];

  const joined = workspaces.find((each) => each.id === search.workspace);
  const defaults = computeThreadDefaults(
    settings.user,
    instances,
    runners,
    profiles,
    localRunnerId,
  );

  // The config is rebuilt on every render instead of being captured once, so
  // a provider login that finishes while the draft is open still reaches it.
  // The composer applies the user's picks on top of this config.
  //
  // The search params are passed on unchanged: the project, and the workspace
  // to join if there is one. The composer decides where a draft with no
  // workspace opens, and which runner a joined workspace uses.
  const config = {
    ...defaults,
    options: {},
    projectId: search.project ?? null,
    workspace:
      search.workspace === undefined
        ? null
        : ({ kind: "existing", workspaceId: search.workspace } as const),
    preferredWorkspace: settings.user["thread.workspace"] ?? null,
  };

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={projects.find((each) => each.id === search.project)?.name}
        title="New thread"
        tabs={buildSiblingTabs({ workspace: joined, sessions, activeSessionId: null, draft: true })}
      />
      <ThreadColumn className="justify-end">
        <Composer thread={{ kind: "draft", config }} />
      </ThreadColumn>
    </div>
  );
}
