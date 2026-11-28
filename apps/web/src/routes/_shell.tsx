import type { JSX } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useLiveInvalidation } from "../app/live-invalidation";
import { modelProfilesQuery, settingsQuery } from "../app/queries";
import { Shell } from "../shell";

/**
 * The app shell. Every screen inside the app is a child of this route, so the
 * sidebar, the top bar and the pulse are mounted once and survive navigation;
 * setup, login and the onboarding steps sit outside it.
 *
 * The settings the shell reads are already in the cache: the entry guard reads
 * them before any route loads. The loader adds the Model Profiles, which the
 * composer's model menu and Settings > Threads draw on every screen, so no
 * screen below suspends on them.
 */
export const Route = createFileRoute("/_shell")({
  loader: ({ context }) => context.queryClient.ensureQueryData(modelProfilesQuery(context.client)),
  component: ShellLayout,
});

function ShellLayout(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  // A sign-in, a new Model Catalog or a profile edit reaches the Model
  // Profiles only through this topic. It is subscribed here, not by the
  // screens that draw the profiles, so it holds on every screen.
  useLiveInvalidation(live, queryClient, "provider");

  return (
    <Shell settings={settings} client={client} queryClient={queryClient} live={live}>
      <Outlet />
    </Shell>
  );
}
