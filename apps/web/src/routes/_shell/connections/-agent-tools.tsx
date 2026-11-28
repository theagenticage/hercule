import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import {
  describeAgentToolsNote,
  joinOfferedServers,
  describeUnavailableAgentToolsNote,
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
 *
 * The servers are read here, not by the screen's loader, because a failed
 * read must not stop the Connection's own actions. Until they are read the
 * note is not drawn. When the read failed and nothing is cached, the note is
 * "agent tools: not available" in muted ink and leads nowhere, once for the
 * Connection.
 */
export function AgentToolsNote({
  client,
  connection,
}: {
  readonly client: HerculeClient;
  readonly connection: Connection;
}): JSX.Element | null {
  const read = useQuery(mcpServersQuery(client));
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const offered = joinOfferedServers({
    servers: read.data?.items ?? [],
    connections: [connection],
    plugins,
  });
  if (offered.length === 0 || (read.data === undefined && read.error === null)) return null;
  if (read.data === undefined) {
    return (
      <span className="self-start text-fine text-muted">
        {describeUnavailableAgentToolsNote().words}
      </span>
    );
  }

  return (
    <>
      {offered.map(({ server, offer }) => {
        const { words, failing } = describeAgentToolsNote(server);
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
        return server === null ? (
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
            params={{ id: server.id }}
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
