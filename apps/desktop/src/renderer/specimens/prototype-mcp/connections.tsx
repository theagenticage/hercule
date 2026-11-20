/**
 * PROTOTYPE, throwaway. Settings > Connections, drawn again from the
 * prototype's world. A Connection whose plugin offers an MCP server says so
 * under its name, and whether that server is on: a filled dot for on, a ring
 * for off, the red dot for a server that needs attention. The line only leads
 * to Settings > MCP servers: the switch is there, and nowhere else.
 */
import type { JSX } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { MoreIcon } from "../../icons/more";
import { usePopoverMenu } from "../../screens/use-popover-menu";
import "../../screens/settings/connections/connections.css";
import { ConnMark, describeStatus, isFailing } from "./parts";
import { describeConnection, findConnectionServer, type Conn, type World } from "./world";

const formatCount = (count: number): string => count.toLocaleString("en-US");

/** Returns 24 bar heights for a Connection, the same on every draw. */
const buildBars = (connection: Conn): number[] => {
  let seed = [...connection.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Array.from({ length: 24 }, (_, hour) => {
    seed = (seed * 9301 + 49297) % 233280;
    return Math.round(18 + (seed / 233280) * 50 + (hour > 16 ? 26 : 0));
  });
};

function RowMenu({
  name,
  onOpenTools,
}: {
  readonly name: string;
  /** Opens the Connection's server in Settings > MCP servers, or undefined when its plugin offers none. */
  readonly onOpenTools: (() => void) | undefined;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const label = `More for ${name}`;
  return (
    <>
      <button
        type="button"
        className="icon-btn conn-more"
        {...triggerProps}
        aria-label={label}
        title="More"
      >
        <MoreIcon />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={label}
        className="pop popover-menu conn-menu"
      >
        <button type="button" {...buildItemProps("reconnect")} onClick={close}>
          Reconnect…
        </button>
        <button type="button" {...buildItemProps("configure")} onClick={close}>
          Configure…
        </button>
        {onOpenTools !== undefined && (
          <button
            type="button"
            {...buildItemProps("tools")}
            onClick={() => {
              close();
              onOpenTools();
            }}
          >
            Agent tools…
          </button>
        )}
        <button type="button" {...buildItemProps("delete")} onClick={close}>
          Delete…
        </button>
      </div>
    </>
  );
}

/**
 * Settings > Connections. `onOpenTools` opens Settings > MCP servers on the
 * Connection's server, or on the list when the server is not switched on.
 */
export function ConnectionsPage({
  w,
  onOpenTools,
}: {
  readonly w: World;
  readonly onOpenTools: (connection: Conn) => void;
}): JSX.Element {
  const failing = w.connections.filter((connection) => connection.failing !== null).length;
  const total = w.connections.reduce((sum, connection) => sum + connection.events, 0);
  return (
    <>
      <div className="conn-stats">
        <div className="conn-stat">
          <b>{formatCount(total)}</b>
          <span>events in 24 hours</span>
        </div>
        <div className="conn-stat">
          <b>{w.connections.length}</b>
          <span>event sources</span>
        </div>
        <div className="conn-stat">
          <b className={failing > 0 ? "is-fail" : undefined}>{failing}</b>
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
        {w.connections.map((connection) => {
          const name = describeConnection(connection);
          const server = findConnectionServer(w, connection.id);
          const offers = connection.offeredOrigin !== null;
          const open = (): void => {
            onOpenTools(connection);
          };
          return (
            <div key={connection.id} className={connection.failing ? "conn is-fail" : "conn"}>
              <span className="mk">
                <ConnMark connection={connection} />
              </span>
              <span className="nm">
                <b title={name}>{name}</b>
                <span className="pm-conn-line">
                  <span>{connection.account}</span>
                  {offers && (
                    <button
                      type="button"
                      className={
                        server === undefined || server.status === "disabled"
                          ? "pm-offer"
                          : isFailing(server.status)
                            ? "pm-offer is-fail"
                            : "pm-offer is-on"
                      }
                      title="Agent tools are switched on and off in Settings > MCP servers"
                      onClick={open}
                    >
                      <i
                        className={
                          server !== undefined && isFailing(server.status) ? "dot dot--fail" : "dot"
                        }
                      />
                      {server === undefined || server.status === "disabled"
                        ? "agent tools off"
                        : isFailing(server.status)
                          ? `agent tools: ${describeStatus(server.status)}`
                          : "agent tools on"}
                      <ChevronRightIcon size={10} />
                    </button>
                  )}
                </span>
              </span>
              <span className="spark" aria-hidden="true">
                {buildBars(connection).map((height, hour) => (
                  <i key={hour} style={{ height: `${String(height)}%` }} />
                ))}
              </span>
              <span className="n">{formatCount(connection.events)}</span>
              {connection.failing !== null ? (
                <span className="health health--fail">
                  <i className="dot dot--fail" />
                  {connection.failing}
                </span>
              ) : (
                <span className="health">healthy</span>
              )}
              <RowMenu name={name} onOpenTools={offers ? open : undefined} />
            </div>
          );
        })}
      </section>
    </>
  );
}
