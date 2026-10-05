import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import { connectionNeedsAttention } from "@hercule/client-core";
import { connectionsQuery } from "../../../../app/queries";
import { SettingsFrame } from "../../../../screens/settings/settings-frame";
import { SettingsList } from "../../../../screens/settings/settings-list";

/**
 * Settings: the layout route of its sections (spec 17 §Settings). It draws
 * the frame, the header and the Settings list, around the open section, one
 * child route each. Each section is a chunk of its own, loaded the first
 * time it opens.
 *
 * The list's Connections dot reads the Connections, which the shell's loader
 * has already read and the live connection keeps current, so this route
 * reads nothing of its own.
 */
export const Route = createFileRoute("/_connected/_shell/settings")({
  component: SettingsLayout,
});

function SettingsLayout(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const connections = useSuspenseQuery(connectionsQuery(controller.client)).data;
  // The header's title is the open section's name, which the section's route sets in staticData.
  const title = useMatches({ select: (matches) => matches.at(-1)?.staticData.title ?? "" });
  return (
    <SettingsFrame
      title={title}
      list={
        <SettingsList someConnectionNeedsAttention={connections.some(connectionNeedsAttention)} />
      }
    >
      <Outlet />
    </SettingsFrame>
  );
}
