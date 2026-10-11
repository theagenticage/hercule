import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listIntakeSegments, readErrorMessage, type IntakeSegment } from "@hercule/client-core";
import { connectionQuery, connectionsQuery, pluginsQuery } from "../../../../app/queries";
import { SourceMark } from "../../../../screens/intake/source-mark";
import { IntakeSegments } from "../../../../screens/settings/intake/intake-segments";
import { IntakeLists } from "./-intake-lists";

/** The key of the segment that edits the plugin's own level. A Connection's id is the key of its segment. */
const PLUGIN_SEGMENT_KEY = "plugin";

/** Returns the key that tells a segment from the others. */
const readSegmentKey = (segment: IntakeSegment): string =>
  segment.target === "plugin" ? PLUGIN_SEGMENT_KEY : segment.connectionId;

/**
 * Renders the section of one plugin on Settings > Intake: its mark and name,
 * a control that picks all its Connections or one of them, and the lists of
 * the level picked. The control is not drawn for a plugin with no Connection.
 *
 * The level picked is this section's own state. It starts on the Connection
 * `connectionId`, when the plugin has it, and on all Connections otherwise.
 * `kind` is the kind a link asks for. Its row is highlighted in the level the
 * link picked, and no longer after the user picks another.
 *
 * The plugin's own level is read from the plugin list, which the shell holds.
 * A Connection's level needs a read of that Connection, made only while its
 * segment is picked.
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
  const linkedSegment = segments.find((segment) => readSegmentKey(segment) === connectionId);
  const [pickedKey, setPickedKey] = useState(
    linkedSegment === undefined ? PLUGIN_SEGMENT_KEY : readSegmentKey(linkedSegment),
  );
  const [pointedKind, setPointedKind] = useState(kind);
  if (plugin === undefined) return null;

  // A Connection deleted while its segment is picked leaves All connections.
  const picked = segments.find((segment) => readSegmentKey(segment) === pickedKey);
  return (
    <section className="set-sec">
      <h2>
        <SourceMark pluginId={plugin.id} plugins={plugins} size={16} />
        {plugin.displayName}
      </h2>
      {segments.length > 0 && (
        <IntakeSegments
          name={`${plugin.displayName} connections`}
          choices={segments.map((segment) => ({
            key: readSegmentKey(segment),
            label: segment.label,
          }))}
          selectedKey={picked === undefined ? PLUGIN_SEGMENT_KEY : readSegmentKey(picked)}
          onSelect={(key) => {
            setPickedKey(key);
            setPointedKind(undefined);
          }}
        />
      )}
      {picked?.target === "connection" ? (
        <ConnectionLists
          key={picked.connectionId}
          connectionId={picked.connectionId}
          pluginName={plugin.displayName}
          pointedKind={pointedKind}
        />
      ) : (
        <IntakeLists
          key={PLUGIN_SEGMENT_KEY}
          target={{ level: "plugin", pluginId: plugin.id }}
          stored={plugin.intake}
          pluginName={plugin.displayName}
          pointedKind={pointedKind}
        />
      )}
    </section>
  );
}

/**
 * Renders the lists of one Connection's level. While its settings are being
 * read, a line says so instead of the lists; when the read fails, the line
 * gives the error.
 */
function ConnectionLists({
  connectionId,
  pluginName,
  pointedKind,
}: {
  readonly connectionId: string;
  readonly pluginName: string;
  readonly pointedKind: string | undefined;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const connection = useQuery(connectionQuery(client, connectionId));
  if (connection.data !== undefined) {
    return (
      <IntakeLists
        target={{ level: "connection", connectionId }}
        stored={connection.data.intake}
        pluginName={pluginName}
        pointedKind={pointedKind}
      />
    );
  }
  if (connection.error !== null) {
    return (
      <p className="set-err intake-status" role="alert">
        {`Could not read this Connection: ${readErrorMessage(connection.error)}`}
      </p>
    );
  }
  return <p className="intake-status">{"Reading this Connection's settings…"}</p>;
}
