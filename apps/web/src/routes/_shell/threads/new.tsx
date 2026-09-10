import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  localRunnerQuery,
  profilesQuery,
  providersQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { Composer } from "../../../screens/composer/composer";

/**
 * The composer in new-thread mode (spec 14 §The composer): "Creating a thread
 * is one step." A static route, so it must resolve ahead of the param route
 * beside it (`$sessionId.tsx`) rather than reading "new" as a session id -
 * TanStack Router ranks a static segment above a param one on its own, so
 * nothing here has to arrange that.
 */
export const Route = createFileRoute("/_shell/threads/new")({
  staticData: { title: "What should the agent do?" },
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

  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-1 flex-col justify-end">
      <Composer
        client={client}
        instances={instances}
        runners={runners}
        profiles={profiles}
        localRunnerId={localRunnerId}
        settingsUser={settings.user}
      />
    </div>
  );
}
