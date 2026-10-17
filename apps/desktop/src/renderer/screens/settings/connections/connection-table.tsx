import type { JSX } from "react";
import {
  describeConnectionHealth,
  describeConnectionTypeName,
  showsAccountBesideLabel,
  summarizeConnections,
  type ConnectionActivity,
  type ConnectionType,
  type PluginIdentity,
} from "@hercule/client-core";
import type { Connection, EventCountsByConnection } from "@hercule/contract";
import { ConnectionTypeMark } from "./connection-type-mark";
import { ConnectionRowMenu } from "./connection-row-menu";
import "./connections.css";

/** Writes a count as the book does, with a comma between thousands: "2,418". */
const formatCount = (count: number): string => count.toLocaleString("en-US");

/**
 * Renders Settings > Connections' page (spec 17 §Settings, Connections): a
 * strip of counts, then the "Event sources" table with one row per
 * Connection, in the order given. Every Connection type the plugins declare
 * today has an event source, so every Connection is a row.
 *
 * The strip shows, from `counts`:
 *
 * - the events all the Connections received in the last 24 hours;
 * - how many Connections there are;
 * - how many are failing, in the fail colour while there is one.
 *
 * Each row shows:
 *
 * - the mark of the plugin that declares the Connection's type, or the
 *   initial of the plugin's id when `plugins` does not hold that plugin;
 * - "<type> · <label>", where <type> is the type's display name, or the
 *   Connection's raw type when the binary no longer holds the type;
 * - under it, the account the Connection acts as, unless the label already
 *   is that account's name (`showsAccountBesideLabel`). The line is then
 *   left out rather than repeat the name;
 * - one bar per hour of the last 24, the busiest hour's the tallest, and
 *   the events of those 24 hours;
 * - its health in words. A failing Connection reads its status detail in
 *   the fail colour, with a dot, on a tinted row. The detail wraps rather
 *   than end in an ellipsis, because the user needs all of it;
 * - the ⋯ menu, whose items call `onReconnect`, `onConfigure` and
 *   `onDelete` with the Connection.
 *
 * With no Connection, a quiet note takes the place of the strip and the
 * table, as Settings > Assistants draws one with no assistant. It points to
 * Add a Connection, or, when `types` is empty, says that no installed plugin
 * offers a type.
 */
export function ConnectionTable({
  connections,
  counts,
  types,
  plugins,
  onReconnect,
  onConfigure,
  onDelete,
}: {
  readonly connections: ReadonlyArray<Connection>;
  /** The events of the last 24 hours, as `event.countByConnection` returns them. */
  readonly counts: EventCountsByConnection;
  readonly types: ReadonlyArray<ConnectionType>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** Reconnect is offered only while the Connection's type is in the binary. */
  readonly onReconnect: (connection: Connection, type: ConnectionType) => void;
  readonly onConfigure: (connection: Connection) => void;
  readonly onDelete: (connection: Connection) => void;
}): JSX.Element {
  if (connections.length === 0) {
    return (
      <section className="connection-list">
        <div className="sec-top">
          <h2>Event sources</h2>
          <span>Where work comes from</span>
        </div>
        <div className="set-empty">
          <b>No Connections yet</b>
          <span>
            {types.length === 0
              ? "No installed plugin offers a Connection type, so there is nothing to add yet."
              : "Events come in through a Connection, and agents act through it. Add one with Add a Connection."}
          </span>
        </div>
      </section>
    );
  }
  const summary = summarizeConnections(connections, counts);
  return (
    <>
      <div className="conn-stats">
        <div className="conn-stat">
          <b>{formatCount(summary.eventCount)}</b>
          <span>{summary.eventCount === 1 ? "event in 24 hours" : "events in 24 hours"}</span>
        </div>
        <div className="conn-stat">
          <b>{formatCount(connections.length)}</b>
          <span>{connections.length === 1 ? "event source" : "event sources"}</span>
        </div>
        <div className="conn-stat">
          <b className={summary.failingCount > 0 ? "is-fail" : undefined}>
            {formatCount(summary.failingCount)}
          </b>
          <span>failing</span>
        </div>
        <span className="spacer" />
        <div className="conn-stats-note">
          Triage reads these events
          <br />
          and prepares work for you.
        </div>
      </div>
      <section className="connection-list">
        <div className="sec-top">
          <h2>Event sources</h2>
          <span>Where work comes from</span>
        </div>
        <div className="tbl-h">
          <span />
          <span>Connection</span>
          <span>Last 24 hours</span>
          <span className="r">Events</span>
          <span>Health</span>
          <span />
        </div>
        {connections.map((connection) => {
          const type = types.find((each) => each.type === connection.type);
          const name = `${describeConnectionTypeName(connection, type)} · ${connection.label}`;
          const health = describeConnectionHealth(connection);
          // `summarizeConnections` returns an entry for every Connection it is given.
          const activity = summary.activity.get(connection.id)!;
          return (
            <div key={connection.id} className={health.failing ? "conn is-fail" : "conn"}>
              <span className="mk">
                <ConnectionTypeMark type={connection.type} plugins={plugins} />
              </span>
              <span className="nm">
                <b title={name}>{name}</b>
                {showsAccountBesideLabel(connection) && <span>{connection.displayName}</span>}
              </span>
              <HourlyBars activity={activity} />
              <span className="n">{formatCount(activity.total)}</span>
              {health.failing ? (
                <span className="health health--fail" title={health.text}>
                  <i className="dot dot--fail" />
                  {health.text}
                </span>
              ) : (
                <span className="health">{health.text}</span>
              )}
              <ConnectionRowMenu
                name={name}
                onReconnect={
                  type === undefined
                    ? undefined
                    : () => {
                        onReconnect(connection, type);
                      }
                }
                onConfigure={() => {
                  onConfigure(connection);
                }}
                onDelete={() => {
                  onDelete(connection);
                }}
              />
            </div>
          );
        })}
      </section>
    </>
  );
}

/**
 * Draws a Connection's last 24 hours as one bar per hour, oldest on the
 * left. Each bar's tooltip gives its count. The row's event count says the
 * same in words, so the bars are hidden from assistive technology.
 */
function HourlyBars({ activity }: { readonly activity: ConnectionActivity }): JSX.Element {
  return (
    <span className="spark" aria-hidden="true">
      {activity.hourly.map((count, hour) => (
        <i
          // The hours never move or reorder, so their place is their key.
          key={hour}
          style={{ height: `${String(activity.barHeights[hour])}%` }}
          title={`${formatCount(count)} ${count === 1 ? "event" : "events"}`}
        />
      ))}
    </span>
  );
}
