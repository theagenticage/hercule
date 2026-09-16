import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  defaultWorkspacePick,
  projectRepos,
  siblingTabs,
  threadDefaults,
} from "@hydra/client-core";
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

/** Where a draft opens: the project it belongs to, and the workspace it joins. */
interface DraftSearch {
  readonly project?: string;
  readonly workspace?: string;
}

/**
 * A draft thread (spec 14 §The composer): "Creating a thread is one step,
 * after the project." A static route, so it must resolve ahead of the param
 * route beside it (`$sessionId.tsx`) rather than reading "new" as a session id
 * - TanStack Router ranks a static segment above a param one on its own.
 *
 * The project picker, a project's `+` and a workspace's `+` all land here with
 * the address saying where the draft stands; nothing else carries that.
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
      // The catalogs the workspace menu reads. Prefetched rather than ensured:
      // a controller that cannot answer them leaves a draft with no project to
      // stand in, which is a composer with fewer choices, not a broken screen.
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
  const resources = useQuery(resourcesQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];

  const joined = workspaces.find((each) => each.id === search.workspace);
  const defaults = threadDefaults(settings.user, instances, runners, profiles, localRunnerId);

  // Resolved every render rather than snapshotted: a login landing while the
  // draft is open has to reach it, and the composer lays the picks over this.
  const config = {
    ...defaults,
    options: {},
    projectId: search.project ?? null,
    // Joining a workspace sets the machine as a default, because a workspace
    // is on one machine and never moves; it locks nothing else.
    ...(joined === undefined ? {} : { runnerId: joined.runnerId }),
    // Resolved here rather than left to the selector, because it is what rides
    // the submission: the address's workspace where there is one, else the
    // default the stored setting and the project's repos decide.
    workspace:
      joined === undefined
        ? defaultWorkspacePick(
            projectRepos(resources, search.project ?? null),
            settings.user["thread.workspace"] ?? null,
          )
        : ({ kind: "existing", workspaceId: joined.id } as const),
    preferredWorkspace: settings.user["thread.workspace"] ?? null,
  };

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={projects.find((each) => each.id === search.project)?.name}
        title="New thread"
        tabs={siblingTabs({ workspace: joined, sessions, activeSessionId: null, draft: true })}
      />
      <ThreadColumn className="justify-end">
        <Composer thread={{ kind: "draft", config }} />
      </ThreadColumn>
    </div>
  );
}
