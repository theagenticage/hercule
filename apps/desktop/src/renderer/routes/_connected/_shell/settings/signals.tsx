import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listIntakeSettingsPluginIds } from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import { ignoreRulesQuery, pluginsQuery, readOnOpen, settingsQuery } from "../../../../app/queries";
import { PluginSection } from "./-plugin-section";

/**
 * Settings > Signals: for each plugin that raises signals or reads events,
 * which of its signal kinds are raised and which of its event kinds triage
 * may read (spec 17 §Settings, Signals). Every toggle saves as soon as it is
 * pressed. A plugin that has Ignore Rules keeps its section for them, even
 * after it stops declaring the kinds or is removed.
 *
 * The plugin list and the Connection list are the shell's reads, which the
 * live connection keeps current. A Connection's own settings are read when
 * its segment is picked.
 *
 * No live topic covers the Ignore Rules, so the loader reads them each time
 * the section opens, with the settings whose `retention.events` names the
 * span a rule's catches cover.
 */
export const Route = createFileRoute("/_connected/_shell/settings/signals")({
  staticData: { title: "Signals" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      readOnOpen(queryClient, ignoreRulesQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/signals");
  },
  component: Signals,
});

function Signals(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const pluginIds = listIntakeSettingsPluginIds(
    useSuspenseQuery(pluginsQuery(client)).data,
    useSuspenseQuery(ignoreRulesQuery(client)).data,
  );
  return (
    <>
      <p className="intake-lead">
        Workflows and subscriptions receive every event, whatever you choose here.
      </p>
      {pluginIds.map((id) => (
        <PluginSection key={id} pluginId={id} />
      ))}
    </>
  );
}
