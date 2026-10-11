import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listIntakeSegments } from "@hercule/client-core";
import { connectionsQuery, pluginsQuery } from "../../../../app/queries";
import { SourceMark } from "../../../../screens/intake/source-mark";
import { IntakeSegments } from "../../../../screens/settings/intake/intake-segments";
import { IntakeLists } from "./-intake-lists";

/**
 * Renders the section of one plugin on Settings > Intake: its mark and name,
 * a control that picks all its Connections or one of them, and the lists of
 * the level picked. The control is not drawn for a plugin with no Connection.
 *
 * The level picked is this section's own state. It starts on the Connection
 * `connectionId`, when the plugin has it, and on all Connections otherwise.
 * `kind` is the kind a link asks for. Its row is highlighted in the level the
 * link picked, and no longer after the user picks another.
 */
export function PluginSection({
  pluginId,
  connectionId,
  kind,
}: {
  readonly pluginId: string;
  readonly connectionId: string | undefined;
  readonly kind: string | undefined;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugin = plugins.find(({ id }) => id === pluginId);
  const segments = plugin === undefined ? [] : listIntakeSegments(plugin, connections);
  const hasConnection = (id: string | undefined): boolean =>
    segments.some((segment) => segment.connectionId === id);
  const [pickedId, setPickedId] = useState(hasConnection(connectionId) ? connectionId : undefined);
  const [pointedKind, setPointedKind] = useState(kind);
  if (plugin === undefined) return null;

  // A Connection deleted while its segment is picked leaves All connections.
  const levelId = hasConnection(pickedId) ? pickedId : undefined;
  return (
    <section className="set-sec">
      <h2>
        <SourceMark pluginId={plugin.id} plugins={plugins} size={16} />
        {plugin.displayName}
      </h2>
      {segments.length > 0 && (
        <IntakeSegments
          name={`${plugin.displayName} connections`}
          segments={segments}
          selectedConnectionId={levelId}
          onSelect={(id) => {
            setPickedId(id);
            setPointedKind(undefined);
          }}
        />
      )}
      <IntakeLists
        // Each level starts its rows over, so a row's highlight does not
        // carry from one level to the next.
        key={levelId ?? ""}
        pluginId={plugin.id}
        connectionId={levelId}
        pluginName={plugin.displayName}
        pointedKind={pointedKind}
      />
    </section>
  );
}
