import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listIntakeSettingsPluginIds } from "@hercule/client-core";
import { isId } from "@hercule/contract";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import {
  connectionQuery,
  connectionsQuery,
  ignoreRulesQuery,
  pluginsQuery,
  readOnOpen,
  settingsQuery,
} from "../../../../app/queries";
import { PluginSection } from "./-plugin-section";

/** The search parameters of Settings > Intake, both set by a link from a signal. */
interface IntakeSettingsSearch {
  /** The kind whose row scrolls into view and is highlighted. */
  readonly kind?: string;
  /** The Connection whose segment is picked, in the plugin that has it. */
  readonly connection?: string;
}

/**
 * Returns the search parameters of Settings > Intake from the URL's. A `kind`
 * that is not text, and a `connection` that is not an id, are dropped. A
 * `kind` or a `connection` that no plugin has is kept: the section ignores it.
 */
const validateIntakeSettingsSearch = (search: Record<string, unknown>): IntakeSettingsSearch => ({
  ...(typeof search.kind === "string" && search.kind !== "" ? { kind: search.kind } : {}),
  ...(isId(search.connection) ? { connection: search.connection } : {}),
});

/**
 * Settings > Intake: for each plugin that raises signals or reads events,
 * which of its signal kinds are raised and which of its event kinds triage
 * may read (spec 17 §Settings, Intake). Every toggle saves as soon as it is
 * pressed. A plugin that has Ignore Rules keeps its section for them, even
 * after it stops declaring the kinds or is removed.
 *
 * The plugin list and the Connection list are the shell's reads, which the
 * live connection keeps current. A Connection's own settings are read when
 * its segment is picked. When the URL names a Connection that exists, the
 * loader reads it before the section opens, so the section opens on its
 * segment already drawn.
 *
 * No live topic covers the Ignore Rules, so the loader reads them each time
 * the section opens, with the settings whose `retention.events` names the
 * span a rule's catches cover.
 */
export const Route = createFileRoute("/_connected/_shell/settings/intake")({
  staticData: { title: "Intake" },
  validateSearch: validateIntakeSettingsSearch,
  loaderDeps: ({ search }) => ({ connection: search.connection }),
  loader: async ({ context: { controller, queryClient }, deps }) => {
    const { client } = controller;
    const known = queryClient
      .getQueryData(connectionsQuery(client).queryKey)
      ?.some(({ id }) => id === deps.connection);
    await Promise.all([
      readOnOpen(queryClient, ignoreRulesQuery(client)),
      queryClient.ensureQueryData(settingsQuery(client)),
      deps.connection === undefined || known !== true
        ? undefined
        : queryClient.prefetchQuery(connectionQuery(client, deps.connection)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/intake");
  },
  component: Intake,
});

function Intake(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { kind, connection } = Route.useSearch();
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
        // A new link to this screen starts a section over, on the segment and
        // the row the link names.
        <PluginSection
          key={`${id}:${connection ?? ""}:${kind ?? ""}`}
          pluginId={id}
          connectionId={connection}
          kind={kind}
        />
      ))}
    </>
  );
}
