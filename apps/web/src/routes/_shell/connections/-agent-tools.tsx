import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import {
  buildMcpServerSettingsRows,
  describeAgentToolsNote,
} from "@hercule/client-core/mcp-servers";
import { cn } from "@hercule/ui";
import { mcpServersQuery, pluginsQuery } from "../../../app/queries";

/**
 * The note on a Connection whose plugin offers an MCP server. It says whether
 * the server is on and leads to Settings > MCP servers, the one place to switch
 * it, so a Connection has no switch of its own.
 *
 * - "agent tools off": the server is off, or was never switched on.
 * - "agent tools on": the server is ready.
 * - "agent tools: checking": the server is on and being checked.
 * - "agent tools: needs sign-in" (or unreachable, error): the server needs
 *   the user. This is the one note in the failure colour, with a dot.
 *
 * A server with a record leads to its page, and one with none to the list.
 * A Connection whose plugin offers no server gets no note. A plugin that
 * offers two servers on one Connection gets one note for each.
 */
export function AgentToolsNote({
  client,
  connection,
}: {
  readonly client: HerculeClient;
  readonly connection: Connection;
}): JSX.Element | null {
  const servers = useSuspenseQuery(mcpServersQuery(client)).data.items;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const rows = buildMcpServerSettingsRows({
    servers,
    connections: [connection],
    plugins,
    projects: [],
  });
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map(({ view, offer }) => {
        const { words, failing } = describeAgentToolsNote(view);
        const className = cn(
          "inline-flex items-center gap-1.5 self-start text-fine hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          failing ? "text-fail" : "text-muted",
        );
        const content = (
          <>
            {failing ? (
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fail" />
            ) : null}
            {words}
          </>
        );
        const title = "Agent tools are switched on and off in Settings > MCP servers";
        return view === null ? (
          <Link
            key={offer.contributionId}
            to="/settings/mcp-servers"
            title={title}
            className={className}
          >
            {content}
          </Link>
        ) : (
          <Link
            key={offer.contributionId}
            to="/settings/mcp-servers/$id"
            params={{ id: view.server.id }}
            title={title}
            className={className}
          >
            {content}
          </Link>
        );
      })}
    </>
  );
}
