import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { buildMcpServerViews, decideThreadStartList } from "@hercule/client-core/mcp-servers";
import { Button, LaneLabel } from "@hercule/ui";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { McpServerPicker } from "../../../../screens/mcp-server-picker";
import { ProviderMark } from "../../../../screens/provider-mark";
import { useWriteServerList } from "./-write-list";

/**
 * The group "Threads without a project": the servers a thread in no project
 * starts with, and the button that opens the picker on that list. The group
 * owns the picker and its write. Each change in the picker is written at
 * once, as every Settings control is.
 */
export function DefaultList({ client }: { readonly client: HerculeClient }): JSX.Element {
  const servers = useSuspenseQuery(mcpServersQuery(client)).data.items;
  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const [picking, setPicking] = useState(false);
  const write = useWriteServerList(client, { kind: "default" });

  const views = buildMcpServerViews(servers, connections, plugins);
  // The default list is never rewritten when a server is deleted, so the
  // start list of a thread in no project is what drops the ids no server has.
  const { mcpServerIds } = decideThreadStartList(
    null,
    [],
    settings.user["thread.mcpServerIds"] ?? [],
    views,
  );
  const failure = write.error === null ? null : readErrorMessage(write.error);

  return (
    <section>
      <LaneLabel>
        Threads without a project
        <span className="ml-2.5 font-normal tracking-normal text-faint normal-case">
          A thread in no project starts with these servers
        </span>
      </LaneLabel>
      <div className="flex max-w-[568px] items-center gap-2 rounded-card border border-line-soft bg-surface px-2.5 py-2">
        <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {mcpServerIds.map((id) => {
            const view = views.find((each) => each.server.id === id)!;
            return (
              <li
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fine"
              >
                <ProviderMark pluginId={view.pluginId} plugins={plugins} />
                <b className="font-emph text-ink">{view.server.name}</b>
                {view.account === undefined ? null : (
                  <span className="text-muted">{view.account}</span>
                )}
              </li>
            );
          })}
          {mcpServerIds.length === 0 ? <li className="text-fine text-faint">None</li> : null}
        </ul>
        <Button
          onClick={() => {
            setPicking(true);
          }}
        >
          Change…
        </Button>
      </div>
      {picking || failure === null ? null : (
        <p className="pt-1.5 text-fine text-fail" role="alert">
          {failure}
        </p>
      )}
      {picking ? (
        <McpServerPicker
          title="MCP servers of threads without a project"
          views={views}
          plugins={plugins}
          mcpServerIds={mcpServerIds}
          foot="Threads started in no project from now on. A thread can still change its own."
          reset={null}
          pending={write.isPending}
          failure={failure}
          onChange={(ids) => {
            write.mutate(() => ids);
          }}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}
