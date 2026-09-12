import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { threadDefaults } from "@hydra/client-core";
import {
  localRunnerQuery,
  profilesQuery,
  providersQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { Composer } from "../../../screens/composer/composer";
import { ThreadChrome, ThreadColumn } from "../../../screens/thread/thread-chrome";

/**
 * A draft thread (spec 14 §The composer): "Creating a thread is one step." A
 * static route, so it must resolve ahead of the param route beside it
 * (`$sessionId.tsx`) rather than reading "new" as a session id - TanStack
 * Router ranks a static segment above a param one on its own.
 */
export const Route = createFileRoute("/_shell/threads/new")({
  staticData: { title: "New thread", ownsTopBar: true },
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
      context.queryClient.ensureQueryData(settingsQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: NewThread,
});

function NewThread(): JSX.Element {
  const { client, detectLocalRunner } = Route.useRouteContext();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;

  // Resolved every render rather than snapshotted: a login landing while the
  // draft is open has to reach it, and the composer lays the picks over this.
  const config = {
    ...threadDefaults(settings.user, instances, runners, profiles, localRunnerId),
    options: {},
  };

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome title="New thread" />
      <ThreadColumn className="justify-end">
        <Composer thread={{ kind: "draft", config }} />
      </ThreadColumn>
    </div>
  );
}
