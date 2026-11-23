import { useState, type JSX } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import type { RuntimeNote } from "@hercule/client-core";
import {
  buildMcpWarningLine,
  type McpServerWarningEntry,
  type WarningFix,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { buildButtonClassName, Button } from "@hercule/ui";
import { TokenDialog } from "../mcp-url-server/token-dialog";
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
  const { client } = useRouteContext({ from: "/_shell" });
  const views = useThreadViews();
  // The server whose token dialog is open, as its button showed it. The dialog belongs to the
  // line, not to the button, because a live change (a delete, a Replace) can remove the button
  // while the dialog is open: the dialog then follows the server and says what happened.
  const [signingIn, setSigningIn] = useState<McpServer | null>(null);
  const dialog =
    signingIn === null ? null : (
      <TokenDialog
        client={client}
        server={views?.find((view) => view.server.id === signingIn.id)?.server ?? signingIn}
        openedOn="elsewhere"
        onClose={() => {
          setSigningIn(null);
        }}
      />
    );
  if (views === undefined) {
    return (
      <>
        <RuntimeNoteLine note={note} />
        {dialog}
      </>
    );
  }
  const { tone, fixes } = buildMcpWarningLine(entries, views);
  return (
    <>
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
                  server={
                    fix.kind === "open-server" || fix.kind === "sign-in"
                      ? views.find((view) => view.server.id === fix.mcpServerId)?.server
                      : undefined
                  }
                  onSignIn={setSigningIn}
                />
              ))
        }
      />
      {dialog}
    </>
  );
}

/**
 * Draws the button of one fix: Reconnect leads to the Connection's reconnect
 * panel, "Open server" to the server's page, and "Sign in…" opens the token
 * dialog of a server added by URL (`onSignIn`, which the line holds). `server`
 * tells apart two buttons of one kind on one line for screen readers, and is
 * the record the token dialog starts from.
 */
function FixButton({
  fix,
  server,
  onSignIn,
}: {
  readonly fix: WarningFix;
  readonly server: McpServer | undefined;
  readonly onSignIn: (server: McpServer) => void;
}): JSX.Element | null {
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
          aria-label={server === undefined ? fix.label : `${fix.label}: ${server.name}`}
          className={className}
        >
          {fix.label}
        </Link>
      );
    case "sign-in":
      return server === undefined ? null : (
        <Button
          variant="primary"
          className="px-1.5 py-0.5 text-meta"
          aria-label={`${fix.label}: ${server.name}`}
          onClick={() => {
            onSignIn(server);
          }}
        >
          {fix.label}
        </Button>
      );
  }
}
