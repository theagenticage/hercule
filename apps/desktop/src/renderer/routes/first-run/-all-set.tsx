import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  buildAllSetRecap,
  resolveDisplayTimezone,
  type FirstRunReads,
  type FirstRunStep,
  type HerculeClient,
} from "@hercule/client-core";
import { firstRunQuery, resourcesQuery, settingsQuery, userQuery } from "../../app/queries";
import { AllSet } from "../../screens/first-run";
import { pickProjectTint } from "../../screens/project-tile";

/**
 * Renders All set, the first run's last screen. Leaving it, by either of its
 * buttons, ends the first run: main forgets it, and the app opens the New
 * thread draft in the first project. Without a logged-in provider, the
 * draft's Log in button is where the user logs in.
 */
export function AllSetCard({
  client,
  reads,
  onDoItNow,
}: {
  readonly client: HerculeClient;
  readonly reads: FirstRunReads;
  readonly onDoItNow: (step: FirstRunStep) => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { timezone } = useSuspenseQuery(settingsQuery(client)).data.user;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const recap = buildAllSetRecap({ ...reads, resources });
  const { project } = recap;

  const endFirstRun = useMutation({
    mutationFn: () => bridge.firstRunProgress.save(null),
    onSuccess: async () => {
      // The entry guard reads the record from the cache, and must find the first run over.
      queryClient.setQueryData(firstRunQuery(bridge).queryKey, null);
      await navigate({ to: "/", search: project === null ? {} : { project: project.id } });
    },
    // A rejection means main refused the message or failed: a bug, which the
    // user cannot act on, so it is logged rather than shown.
    onError: (error) => {
      console.error("Could not end the first run:", error);
    },
  });
  const leave = (): void => {
    if (!endFirstRun.isPending) endFirstRun.mutate();
  };

  return (
    <AllSet
      username={username}
      timezone={resolveDisplayTimezone(timezone)}
      recap={recap}
      tint={project === null ? null : pickProjectTint(project.id, reads.projects)}
      onDoItNow={onDoItNow}
      onLeave={leave}
    />
  );
}
