import { useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Project } from "@hercule/contract";
import { buildDraftConfig, buildSiblingTabs, type HerculeClient } from "@hercule/client-core";
import {
  ensureProviderAccountReads,
  localRunnerQuery,
  modelProfilesQuery,
  profilesQuery,
  projectQuery,
  projectsQuery,
  providerAccountsQuery,
  resourcesQuery,
  runnersQuery,
  sessionsQuery,
  settingsQuery,
  workspacesQuery,
} from "../../../app/queries";
import { readRecentModels } from "../../../app/recent-models";
import { Composer } from "../../../screens/composer/composer";
import { ContentColumn } from "../../../screens/content-column";
import { ThreadChrome } from "../../../screens/thread/thread-chrome";

/** The search params of a draft: the project it belongs to, and the workspace it joins. */
interface DraftSearch {
  readonly project?: string | undefined;
  readonly workspace?: string | undefined;
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
  // An invalid param is returned as `undefined` rather than left out: the
  // router lays the returned params over the URL's, so a param left out would
  // keep the URL's value.
  validateSearch: (search: Record<string, unknown>): DraftSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ context, deps }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      ensureProviderAccountReads(context.queryClient, context.client),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
      context.queryClient.ensureQueryData(settingsQuery(context.client)),
      // The addressed project is ensured, not prefetched: its Model Profile
      // decides which model the draft sends. If it could not be read, the
      // draft would fall back to the user's default model and send it as if
      // the user had chosen it, so a failed read shows the screen's error.
      deps.project === undefined
        ? undefined
        : context.queryClient.ensureQueryData(projectQuery(context.client, deps.project)),
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

/**
 * Reads the addressed project, if the URL names one, and draws the draft with
 * it. The loader has already read it, so this never renders without it.
 */
function NewThread(): JSX.Element {
  const { client } = Route.useRouteContext();
  const { project: projectId } = Route.useSearch();
  return projectId === undefined ? (
    <Draft project={undefined} />
  ) : (
    <ProjectDraft client={client} projectId={projectId} />
  );
}

function ProjectDraft({
  client,
  projectId,
}: {
  readonly client: HerculeClient;
  readonly projectId: string;
}): JSX.Element {
  return <Draft project={useSuspenseQuery(projectQuery(client, projectId)).data} />;
}

function Draft({ project }: { readonly project: Project | undefined }): JSX.Element {
  const { client, detectLocalRunner } = Route.useRouteContext();
  const search = Route.useSearch();
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const modelProfiles = useSuspenseQuery(modelProfilesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const thisMacRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];

  // Read once: the composer writes Recent only after a send, which leaves
  // this screen for the new thread.
  const [recent] = useState(readRecentModels);
  const joined = workspaces.find((each) => each.id === search.workspace);
  // The composer applies the user's picks on top of this config. It decides
  // where a draft that joins no workspace opens, and which runner a joined
  // workspace uses. In a project that names a Model Profile it also decides
  // the model, from the user's recent picks.
  const config = buildDraftConfig({
    settingsUser: settings.user,
    accounts,
    runners,
    profiles,
    thisMacRunnerId,
    modelProfiles,
    projects: project === undefined ? [] : [project],
    recent,
    projectId: search.project ?? null,
    workspaceId: search.workspace ?? null,
  });

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={project?.name}
        title="New thread"
        tabs={buildSiblingTabs({ workspace: joined, sessions, activeSessionId: null, draft: true })}
      />
      <ContentColumn className="justify-end">
        <Composer thread={{ kind: "draft", config }} />
      </ContentColumn>
    </div>
  );
}
