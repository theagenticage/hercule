import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { HerculeClient } from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import {
  buildOfferSwitchTarget,
  describeNamingProjects,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import { Switch } from "@hercule/ui";
import { useMcpServerSwitch } from "../../../../app/mcp-server-switch";
import { McpServerStatusWord } from "../../../../screens/mcp-server-status";
import { ProviderMark } from "../../../../screens/provider-mark";

/**
 * One row of "From your Connections": the server a Connection's plugin offers,
 * and the switch that offers it to threads. The row owns the switch's write,
 * because a write changes only this server.
 *
 * - A server with a record opens its page when the row is pressed.
 * - A server with no record yet has no page. Its switch creates the record,
 *   and a switch that is already on writes `enabled` instead.
 * - The switch ignores clicks while its write runs, even if the row was drawn
 *   again meanwhile, and a refusal shows under the row. Whether a press creates
 *   the server or updates its record is decided when it is pressed.
 */
export function ServerRow({
  client,
  row,
  plugins,
}: {
  readonly client: HerculeClient;
  readonly row: McpServerSettingsRow;
  readonly plugins: readonly PluginDetail[];
}): JSX.Element {
  const { view } = row;

  const switchServer = useMcpServerSwitch(client, buildOfferSwitchTarget(row));

  const naming = describeNamingProjects(row.projects);
  const content: ReactNode = (
    <>
      <ProviderMark pluginId={row.offer.pluginId} plugins={plugins} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <b className="font-emph text-ink">{row.name}</b>{" "}
          <span className="text-muted">{row.connection.label}</span>
        </span>
        <small className="block truncate text-fine text-muted">{row.secondLine}</small>
      </span>
      <span className="w-[92px] shrink-0">
        <McpServerStatusWord view={view} />
      </span>
      <span
        title={naming.kind === "count" ? naming.tooltip : "Projects that name this server"}
        className="w-[104px] shrink-0 text-fine"
      >
        {naming.kind === "tiles" ? (
          naming.projects.map((project) => (
            <span key={project.id} className="block truncate text-muted">
              {project.name}
            </span>
          ))
        ) : (
          <span className={naming.kind === "none" ? "text-faint" : "text-muted"}>
            {naming.text}
          </span>
        )}
      </span>
    </>
  );
  const contentClass = "flex min-w-0 flex-1 items-center gap-3 rounded-control px-2.5 py-[7px]";

  return (
    <li className="flex flex-col">
      <div className="flex items-center">
        {view === null ? (
          <div className={contentClass}>{content}</div>
        ) : (
          <Link
            to="/settings/mcp-servers/$id"
            params={{ id: view.server.id }}
            className={`${contentClass} hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live`}
          >
            {content}
          </Link>
        )}
        <span className="shrink-0 px-2.5">
          <Switch
            aria-label={`Offer ${row.name} ${row.connection.label} to threads`}
            aria-disabled={switchServer.blocked}
            checked={view?.server.enabled ?? false}
            onCheckedChange={switchServer.press}
          />
        </span>
      </div>
      {switchServer.problem === null ? null : (
        <p className="px-2.5 pb-1.5 text-fine text-fail" role="alert">
          {switchServer.problem}
        </p>
      )}
    </li>
  );
}
