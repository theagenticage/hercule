/**
 * The thread's line about MCP servers: a refused call, or the servers left out
 * at a start. Loaded the first time such a line is drawn (see
 * `lazy-mcp-warning-line.ts`); until then the transcript draws it as a plain
 * warning.
 */
import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  decideWarningFix,
  isActionableWarning,
  type McpServerWarningEntry,
} from "@hercule/client-core/mcp-servers";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { RuntimeNote } from "./blocks";
import { ReconnectDialog } from "./reconnect-dialog";

/**
 * Renders a runtime warning that names MCP servers (`entries`) as the
 * warning's line, with one button for each server that has a fix: "Reconnect
 * Sentry · work" opens that Connection's Reconnect dialog, and "Open server"
 * goes to the server's page in Settings. A server that was deleted since, and
 * a reason with no fix, draw no button.
 *
 * A line with at least one button is drawn in the failure colours, because
 * the user must act. Every other warning stays quiet. The marker keeps the
 * name "Warning" for a screen reader. This is the one place that decides
 * the colour (spec 17, the runtime lines for MCP servers).
 *
 * The servers come from the cache: the thread's page reads them while it
 * holds a line like this. Until they are read, the line has no button.
 */
export default function McpWarningLine({
  entries,
  message,
  at,
  timezone,
  today,
}: {
  readonly entries: readonly McpServerWarningEntry[];
  readonly message: string;
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
}): JSX.Element {
  const { views } = useMcpServerViews("cache");
  const navigate = useNavigate();
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const known = views ?? [];
  const fixes = entries.flatMap((entry) => {
    const fix = decideWarningFix(entry, known);
    return fix === null ? [] : [{ entry, fix }];
  });
  return (
    <>
      <RuntimeNote
        kind="warning"
        failing={isActionableWarning(entries, known)}
        message={message}
        at={at}
        timezone={timezone}
        today={today}
        actions={
          fixes.length === 0
            ? undefined
            : fixes.map(({ entry, fix }) => (
                <button
                  key={`${entry.mcpServerId}:${entry.reason}`}
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    if (fix.kind === "reconnect") setReconnectingId(fix.connectionId);
                    else
                      void navigate({
                        to: "/settings/mcp-servers/$id",
                        params: { id: fix.mcpServerId },
                      });
                  }}
                >
                  {fix.label}
                </button>
              ))
        }
      />
      {reconnectingId !== null && (
        <ReconnectDialog
          connectionId={reconnectingId}
          onClose={() => {
            setReconnectingId(null);
          }}
        />
      )}
    </>
  );
}
