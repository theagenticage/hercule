import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  buildAllSetRecap,
  findNextOnboardingStep,
  ONBOARDING_STEPS,
  readErrorMessage,
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
 *
 * Before the first run ends, leaving marks the web app's onboarding steps
 * done when the settings still lack any of them. The account step marks them
 * too, but its write can fail, and a relaunch then resumes the first run past
 * the account step. Every resumed first run ends here, so this write is the
 * one that makes sure the web app never asks for onboarding afterwards. When
 * it fails, the error shows and the first run stays, so leaving again tries
 * again.
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
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const recap = buildAllSetRecap({ ...reads, resources });
  const { project } = recap;

  const endFirstRun = useMutation({
    mutationFn: async () => {
      const completedSteps = settings.user["onboarding.completedSteps"] ?? [];
      if (findNextOnboardingStep(completedSteps) !== null) {
        const updated = await client.settings.update({
          payload: { user: { "onboarding.completedSteps": [...ONBOARDING_STEPS] } },
        });
        queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      }
      await bridge.firstRunProgress.save(null);
    },
    onSuccess: async () => {
      // The entry guard reads the record from the cache, and must find the first run over.
      queryClient.setQueryData(firstRunQuery(bridge).queryKey, null);
      await navigate({ to: "/", search: project === null ? {} : { project: project.id } });
    },
  });
  const leave = (): void => {
    if (!endFirstRun.isPending) endFirstRun.mutate();
  };

  return (
    <AllSet
      username={username}
      timezone={resolveDisplayTimezone(settings.user.timezone)}
      recap={recap}
      tint={project === null ? null : pickProjectTint(project.id, reads.projects)}
      error={endFirstRun.isError ? readErrorMessage(endFirstRun.error) : null}
      onDoItNow={onDoItNow}
      onLeave={leave}
    />
  );
}
