import type { JSX } from "react";
import {
  describeConnectionHealth,
  describeConnectionTypeName,
  showsAccountBesideLabel,
  type ConnectionType,
  type PluginIdentity,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { ConnectionTypeMark } from "./connection-type-mark";
import { ConnectionRowMenu } from "./connection-row-menu";
import "./connections.css";

/**
 * Renders Settings > Connections' one section (spec 17 §Settings,
 * Connections): a heading, then a table with one row per Connection, in the
 * order given. Each row shows:
 *
 * - the mark of the plugin that declares the Connection's type, or the
 *   initial of the plugin's id when `plugins` does not hold that plugin;
 * - "<type> · <label>", where <type> is the type's display name, or the
 *   Connection's raw type when the binary no longer holds the type;
 * - under it, the account the Connection acts as, unless the label already
 *   is that account's name (`showsAccountBesideLabel`). The line is then
 *   left out rather than repeat the name;
 * - its health in words. A failing Connection reads its status detail in
 *   the fail colour, with a dot, on a tinted row;
 * - the ⋯ menu, whose items call `onReconnect`, `onConfigure` and
 *   `onDelete` with the Connection.
 *
 * With no Connection, a quiet note takes the table's place, as Settings >
 * Assistants draws one with no assistant. It points to Add a Connection, or,
 * when `types` is empty, says that no installed plugin offers a type.
 */
export function ConnectionTable({
  connections,
  types,
  plugins,
  onReconnect,
  onConfigure,
  onDelete,
}: {
  readonly connections: ReadonlyArray<Connection>;
  readonly types: ReadonlyArray<ConnectionType>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** Reconnect is offered only while the Connection's type is in the binary. */
  readonly onReconnect: (connection: Connection, type: ConnectionType) => void;
  readonly onConfigure: (connection: Connection) => void;
  readonly onDelete: (connection: Connection) => void;
}): JSX.Element {
  return (
    <section className="connection-list">
      <div className="sec-top">
        <h2>Connections</h2>
        <span>The accounts Hercule acts through</span>
      </div>
      {connections.length === 0 ? (
        <div className="set-empty">
          <b>No Connections yet</b>
          <span>
            {types.length === 0
              ? "No installed plugin offers a Connection type, so there is nothing to add yet."
              : "Events come in through a Connection, and agents act through it. Add one with Add a Connection."}
          </span>
        </div>
      ) : (
        <>
          <div className="tbl-h">
            <span />
            <span>Connection</span>
            <span>Health</span>
            <span />
          </div>
          {connections.map((connection) => {
            const type = types.find((each) => each.type === connection.type);
            const name = `${describeConnectionTypeName(connection, type)} · ${connection.label}`;
            const health = describeConnectionHealth(connection);
            return (
              <div key={connection.id} className={health.failing ? "conn is-fail" : "conn"}>
                <span className="mk">
                  <ConnectionTypeMark type={connection.type} plugins={plugins} />
                </span>
                <span className="nm">
                  <b title={name}>{name}</b>
                  {showsAccountBesideLabel(connection) && <span>{connection.displayName}</span>}
                </span>
                {health.failing ? (
                  <span className="health health--fail" title={health.text}>
                    <i className="dot dot--fail" />
                    <span>{health.text}</span>
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
        </>
      )}
    </section>
  );
}
