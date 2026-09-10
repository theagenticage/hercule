import type { JSX } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { settingsQuery } from "../app/queries";
import { Shell } from "../shell";

/**
 * The app shell. Every screen inside the app is a child of this route, so the
 * sidebar, the top bar and the pulse are mounted once and survive navigation;
 * setup, login and the onboarding steps sit outside it.
 *
 * The settings the shell reads are already in the cache: the entry guard reads
 * them before any route loads.
 */
export const Route = createFileRoute("/_shell")({
  component: ShellLayout,
});

function ShellLayout(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;

  return (
    <Shell settings={settings} client={client} queryClient={queryClient} live={live}>
      <Outlet />
    </Shell>
  );
}
