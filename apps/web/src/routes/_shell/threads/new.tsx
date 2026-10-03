import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { buildDraftConfig, buildSiblingTabs } from "@hercule/client-core";
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
import { ContentColumn } from "../../../screens/content-column";
import { ThreadChrome } from "../../../screens/thread/thread-chrome";

/** The search params of a draft: the project it belongs to, and the workspace it joins. */
interface DraftSearch {
  readonly project?: string;
  readonly workspace?: string;
}

/**
 * The draft thread screen. The user picks the project first, because the
 * project bounds the repos and workspaces a thread can use; creating the
 * thread is then this one screen. Spec 14 §The composer owns the flow.
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
  const thisMacRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];

  const joined = workspaces.find((each) => each.id === search.workspace);
  // The composer applies the user's picks on top of this config. It decides
  // where a draft that joins no workspace opens, and which runner a joined
  // workspace uses.
  const config = buildDraftConfig({
    settingsUser: settings.user,
    instances,
    runners,
    profiles,
    thisMacRunnerId,
    projectId: search.project ?? null,
    workspaceId: search.workspace ?? null,
  });

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={projects.find((each) => each.id === search.project)?.name}
        title="New thread"
        tabs={buildSiblingTabs({ workspace: joined, sessions, activeSessionId: null, draft: true })}
      />
      <ContentColumn className="justify-end">
        <Composer thread={{ kind: "draft", config }} />
      </ContentColumn>
    </div>
  );
}
