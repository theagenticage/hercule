import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { HerculeClient } from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import {
  buildServerSwitchTarget,
  type UrlServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import { Switch } from "@hercule/ui";
import { useMcpServerSwitch } from "../../../../app/mcp-server-switch";
import { McpServerMark } from "../../../../screens/mcp-server-mark";
import { McpServerStatusWord } from "../../../../screens/mcp-server-status";
import { NamingProjectsCell } from "./-naming-projects-cell";

/**
 * One row of "Added by URL": the tools mark, the server's name, its whole
 * address and tool count, its status, the projects that name it, and the
 * switch that offers it to threads. The row opens the server's page, which
 * every server added by URL has from the start.
 *
 * The switch shares its guard with the switch on the server's page, so the
 * two never write at once, and a refusal shows under the row. The row does
 * not print the account beside the name: for a server added by URL the
 * account is the address, which the second line already holds.
 */
export function UrlServerRow({
  client,
  row,
  plugins,
}: {
  readonly client: HerculeClient;
  readonly row: UrlServerSettingsRow;
  readonly plugins: readonly PluginDetail[];
}): JSX.Element {
  const { view } = row;
  const { server } = view;
  const switchServer = useMcpServerSwitch(client, buildServerSwitchTarget(server), server.id);

  return (
    <li className="flex flex-col">
      <div className="flex items-center">
        <Link
          to="/settings/mcp-servers/$id"
          params={{ id: server.id }}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-control px-2.5 py-[7px] hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          <McpServerMark view={view} plugins={plugins} />
          <span className="min-w-0 flex-1">
            <b className="block truncate font-emph text-ink">{server.name}</b>
            <small className="block truncate text-fine text-muted">{view.secondLine}</small>
          </span>
          <span className="w-[92px] shrink-0">
            <McpServerStatusWord view={view} />
          </span>
          <NamingProjectsCell projects={row.projects} />
        </Link>
        <span className="shrink-0 px-2.5">
          <Switch
            aria-label={`Offer ${server.name} to threads`}
            aria-disabled={switchServer.blocked}
            checked={server.enabled}
            onCheckedChange={(on) => {
              switchServer.press(on);
            }}
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
