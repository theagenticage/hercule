import type { JSX } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import type { RuntimeNote } from "@hercule/client-core";
import {
  decideWarningFix,
  isActionableWarning,
  type McpServerWarningEntry,
  type WarningFix,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName } from "@hercule/ui";
import { useMcpServerViews } from "../use-mcp-server-views";
import { RuntimeNoteLine } from "./runtime-note-line";

/**
 * Draws one runtime note of the transcript. A warning about MCP servers ends
 * in a button for each server it names that can be fixed (`McpNoteLine`); any
 * other note is the plain line.
 */
export function NoteLine({ note }: { readonly note: RuntimeNote }): JSX.Element {
  return note.mcpServers === undefined ? (
    <RuntimeNoteLine note={note} />
  ) : (
    <McpNoteLine note={note} entries={note.mcpServers} />
  );
}

/**
 * Draws a warning about MCP servers with the buttons that fix it. The button
 * of each entry is decided by `decideWarningFix` from the servers as they are
 * now, not as they were when the line was written. Entries are not merged:
 * two servers that need sign-in give two buttons.
 *
 * A warning with at least one button is one the user must act on, and is
 * drawn in the failure colours, as an error is (`isActionableWarning`). Any
 * other is as quiet as every warning. Until the servers are read the line is
 * quiet and has no button. The screen holding the line reads the servers once
 * and keeps the live topic (see `AgentPage`).
 */
function McpNoteLine({
  note,
  entries,
}: {
  readonly note: RuntimeNote;
  readonly entries: readonly McpServerWarningEntry[];
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_shell" });
  const { views } = useMcpServerViews(client, true);
  if (views === undefined) return <RuntimeNoteLine note={note} />;
  const fixes = entries.flatMap((entry) => {
    const fix = decideWarningFix(entry, views);
    return fix === null ? [] : [{ entry, fix }];
  });
  return (
    <RuntimeNoteLine
      note={isActionableWarning(entries, views) ? { ...note, severity: "error" } : note}
      actions={
        fixes.length === 0
          ? undefined
          : fixes.map(({ entry, fix }, index) => (
              <FixButton
                key={index}
                fix={fix}
                serverName={views.find((view) => view.server.id === entry.mcpServerId)?.server.name}
              />
            ))
      }
    />
  );
}

/**
 * Draws the button of one fix: Reconnect leads to the Connection's reconnect
 * panel, and "Open server" to the server's page. `serverName` tells apart two
 * "Open server" buttons on one line for screen readers.
 */
function FixButton({
  fix,
  serverName,
}: {
  readonly fix: WarningFix;
  readonly serverName: string | undefined;
}): JSX.Element {
  const className = buildButtonClassName("primary", "px-1.5 py-0.5 text-meta");
  switch (fix.kind) {
    case "reconnect":
      return (
        <Link to="/connections" search={{ reconnect: fix.connectionId }} className={className}>
          {fix.label}
        </Link>
      );
    case "open-server":
      return (
        <Link
          to="/settings/mcp-servers/$id"
          params={{ id: fix.mcpServerId }}
          aria-label={serverName === undefined ? fix.label : `${fix.label}: ${serverName}`}
          className={className}
        >
          {fix.label}
        </Link>
      );
  }
}
