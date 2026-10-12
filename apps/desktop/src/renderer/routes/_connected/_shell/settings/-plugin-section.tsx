import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { declaresIntakeKind, listIntakeSegments } from "@hercule/client-core";
import { connectionsQuery, pluginsQuery } from "../../../../app/queries";
import { SourceMark } from "../../../../screens/intake/source-mark";
import { IntakeSegments } from "../../../../screens/settings/intake/intake-segments";
import { IgnoreRules } from "./-ignore-rules";
import { IntakeLists } from "./-intake-lists";

/**
 * Renders the section of one plugin on Settings > Intake: its mark and name,
 * a control that picks all its Connections or one of them, the lists of the
 * level picked, and the plugin's Ignore Rules, which belong to no level. The
 * control is not drawn for a plugin with no Connection.
 *
 * A plugin that declares no intake kind, or is not installed, has a section
 * only for its Ignore Rules, so the section draws its heading and those
 * rules alone. A plugin that is not installed is named by its id.
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
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugin = plugins.find(({ id }) => id === pluginId);
  const name = plugin?.displayName ?? pluginId;
  const hasKinds = plugin !== undefined && declaresIntakeKind(plugin);
  const segments = hasKinds ? listIntakeSegments(plugin, connections) : [];
  const hasConnection = (id: string | undefined): boolean =>
    segments.some((segment) => segment.connectionId === id);
  const [pickedId, setPickedId] = useState(hasConnection(connectionId) ? connectionId : undefined);
  const [pointedKind, setPointedKind] = useState(kind);

  // A Connection deleted while its segment is picked leaves All connections.
  const levelId = hasConnection(pickedId) ? pickedId : undefined;
  return (
    <section className="set-sec">
      <h2>
        <SourceMark pluginId={pluginId} plugins={plugins} size={16} />
        {name}
      </h2>
      {segments.length > 0 && (
        <IntakeSegments
          name={`${name} connections`}
          segments={segments}
          selectedConnectionId={levelId}
          onSelect={(id) => {
            setPickedId(id);
            setPointedKind(undefined);
          }}
        />
      )}
      {hasKinds && (
        <IntakeLists
          // Each level starts its rows over, so a row's highlight does not
          // carry from one level to the next.
          key={levelId ?? ""}
          pluginId={pluginId}
          connectionId={levelId}
          pluginName={name}
          pointedKind={pointedKind}
        />
      )}
      <IgnoreRules pluginId={pluginId} />
    </section>
  );
}
