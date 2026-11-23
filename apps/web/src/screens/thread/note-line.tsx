import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { RuntimeNote } from "@hercule/client-core";
import {
  buildMcpWarningLine,
  type McpServerWarningEntry,
  type WarningFix,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName } from "@hercule/ui";
import { useThreadViews } from "../thread-servers";
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
 * Draws a warning about MCP servers with the buttons that fix it. Its tone and its buttons come from `buildMcpWarningLine`, which
 * decides each button from the servers as they are now, not as they were when
 * the line was written. Entries are not merged: two servers that need sign-in
 * give two buttons.
 *
 * A warning with at least one button is one the user must act on, and is
 * drawn in the failure colours (decided by Rogier, 2026-11-22). Any other is as quiet as every warning. The
 * line keeps its severity either way, so a screen reader still hears
 * "Warning". Until the servers are read the line is quiet and has no button.
 * The page's servers are read once for every line, and the live topic is
 * kept (see `ThreadServersProvider`).
 */
function McpNoteLine({
  note,
  entries,
}: {
  readonly note: RuntimeNote;
  readonly entries: readonly McpServerWarningEntry[];
}): JSX.Element {
  const views = useThreadViews();
  if (views === undefined) return <RuntimeNoteLine note={note} />;
  const { tone, fixes } = buildMcpWarningLine(entries, views);
  return (
    <RuntimeNoteLine
      note={note}
      tone={tone}
      actions={
        fixes.length === 0
          ? undefined
          : fixes.map(({ key, fix }) => (
              <FixButton
                key={key}
                fix={fix}
                serverName={
                  fix.kind === "open-server"
                    ? views.find((view) => view.server.id === fix.mcpServerId)?.server.name
                    : undefined
                }
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
