import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import {
  describeNamingProjects,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import { Switch } from "@hercule/ui";
import { useKeyedWrite } from "../../../../app/use-keyed-write";
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
 *   again meanwhile, and a refusal shows under the row.
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
  const queryClient = useQueryClient();
  const { view } = row;

  const switchServer = useKeyedWrite<boolean>({
    // A server with no record yet is told apart by the Connection and the contribution it would be made for.
    mutationKey: [
      "mcp-server-switch",
      view?.server.id ?? `${row.offer.contributionId}:${row.connection.id}`,
    ],
    mutationFn: async (enabled) => {
      if (view === null) {
        await client.mcpServer.create({
          payload: {
            source: {
              kind: "plugin",
              contributionId: row.offer.contributionId,
              connectionId: row.connection.id,
            },
          },
        });
      } else {
        await client.mcpServer.update({ params: { id: view.server.id }, payload: { enabled } });
      }
    },
    // The list is read again after a refusal too: a `conflict` means another
    // server of this account exists, which the list does not show yet.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServer() }),
      ]),
  });

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
            aria-disabled={switchServer.writing}
            checked={view?.server.enabled ?? false}
            onCheckedChange={(enabled) => {
              switchServer.write(enabled);
            }}
          />
        </span>
      </div>
      {switchServer.refusal === null ? null : (
        <p className="px-2.5 pb-1.5 text-fine text-fail" role="alert">
          {readErrorMessage(switchServer.refusal)}
        </p>
      )}
    </li>
  );
}
