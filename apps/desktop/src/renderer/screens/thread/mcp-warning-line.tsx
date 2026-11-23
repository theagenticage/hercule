/**
 * The thread's line about MCP servers: a refused call, or the servers left out
 * at a start. Loaded the first time such a line is drawn (see
 * `lazy-mcp-warning-line.ts`); until then the transcript draws it as a plain
 * warning.
 */
import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  buildMcpWarningLine,
  type McpServerWarningEntry,
  type SignInAction,
} from "@hercule/client-core/mcp-servers";
import { useThreadViews } from "./thread-servers";
import { RuntimeNote } from "./blocks";
import { SignInDialog } from "./sign-in-dialog";

/**
 * Renders a runtime warning that names MCP servers (`entries`) as the
 * warning's line, with one button for each server that has a fix: "Reconnect
 * Sentry · work" opens that Connection's Reconnect dialog, "Sign in…" (or
 * "Paste a token…") opens the token dialog of a server added by URL, and "Open
 * server" goes to the server's page in Settings. A server that was deleted
 * since, and a reason with no fix, draw no button.
 *
 * `buildMcpWarningLine` decides the buttons and the tone. A line with at
 * least one button is drawn in the failure colours, because the user must
 * act (decided by Rogier, 2026-11-22). Every other warning stays quiet. The
 * line keeps its severity, so the marker keeps the name "Warning" for a
 * screen reader (spec 17, the runtime lines for MCP servers).
 *
 * The servers come from the open thread's servers: its provider reads and
 * joins them once for every line (see `ThreadServersProvider`). Until they
 * are read, the line has no button.
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
  const views = useThreadViews();
  const navigate = useNavigate();
  const [signingIn, setSigningIn] = useState<SignInAction | null>(null);
  const { tone, fixes } = buildMcpWarningLine(entries, views ?? []);
  return (
    <>
      <RuntimeNote
        kind="warning"
        failing={tone === "fail"}
        message={message}
        at={at}
        timezone={timezone}
        today={today}
        actions={
          fixes.length === 0
            ? undefined
            : fixes.map(({ key, fix }) => (
                <button
                  key={key}
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    if (fix.kind === "reconnect" || fix.kind === "sign-in") setSigningIn(fix);
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
      {signingIn !== null && (
        <SignInDialog
          action={signingIn}
          onClose={() => {
            setSigningIn(null);
          }}
        />
      )}
    </>
  );
}
