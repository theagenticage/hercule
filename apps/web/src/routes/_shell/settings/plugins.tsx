import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { pluginsQuery } from "../../../app/queries";
import { PluginCard } from "./-plugin-card";

export const Route = createFileRoute("/_shell/settings/plugins")({
  staticData: { title: "Plugins" },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(pluginsQuery(context.client));
  },
  component: Plugins,
});

/**
 * The Plugins screen: every plugin this binary was built with, in registry
 * order. The list itself never changes while the screen is open, because
 * installing a plugin means a new binary. A plugin's status can change while
 * the controller runs, though, so the screen listens for live updates like
 * every other list.
 */
function Plugins(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "plugin");

  const plugins = useSuspenseQuery(pluginsQuery(client)).data;

  if (plugins.length === 0) {
    return (
      <EmptyState
        headline="No plugins are installed."
        lead="Plugins bring channels, event sources, providers and workflow actions. Each one declares what it contributes, and Hercule generates its configuration form from that."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {plugins.map((plugin) => (
        <PluginCard key={plugin.id} client={client} plugin={plugin} />
      ))}
    </div>
  );
}
