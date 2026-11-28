import { useRef, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  describeServerReadFailure,
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  type SignInEntry,
  type UrlServerDialog,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { useUrlServerAttempt } from "../../../app/mcp-url-flows";
import { mcpServerQuery } from "../../../app/queries";
import { WaitLine, Warning } from "../../step";
import { QuestionIcon } from "../../../icons/question";
import { StepView, UrlServerDialogFrame } from "./url-server-dialog-parts";

/**
 * Renders the sign-in dialog of the server added by URL `mcpServerId`, the one
 * form every way in opens: the page's "Replace token…" and "Sign in again…",
 * the band's "Sign in…" and the "Sign in…" of a thread's line and submenu
 * (spec 17 §Settings, MCP servers). It reads the server, signs in through the
 * browser when the server offers it, or asks for a token and writes it with
 * `mcpServer.setToken`, and follows what the controller's check finds.
 *
 * The token lives in the form's field and in the write, nowhere else. The
 * dialog is kept by the server's id: when the server is removed, or moves onto
 * a Connection, while the dialog is open, the dialog shows why before it closes.
 * `openedOn` is where the dialog was opened: the server's own page, which
 * has no "Open <name>" button to offer, or `elsewhere`. `entry` is the
 * button that opened it, which decides the first step even when the record
 * changes before the dialog reads it. `onClose` is called whenever the dialog
 * closes; the caller then unmounts it.
 */
export function TokenDialog({
  mcpServerId,
  openedOn,
  entry,
  onClose,
}: {
  readonly mcpServerId: string;
  readonly openedOn: "server-page" | "elsewhere";
  readonly entry: SignInEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const server = useQuery(mcpServerQuery(client, mcpServerId));
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (server.data !== undefined) {
    return (
      <TokenDialogFor server={server.data} openedOn={openedOn} entry={entry} onClose={onClose} />
    );
  }
  const failure = server.error;
  const unread = failure === null ? null : describeServerReadFailure(failure);
  return (
    <UrlServerDialogFrame dialogRef={dialogRef} heading="Sign in" onClose={onClose}>
      {unread === null ? (
        <WaitLine text="Reading the server…" />
      ) : (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>{unread.headline}</b> {unread.body}
          </Warning>
          <div className="setup-acts">
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => dialogRef.current?.close()}
            >
              Close
            </button>
          </div>
        </>
      )}
    </UrlServerDialogFrame>
  );
}

/** Renders the dialog once the server is read: the attempt belongs to this server. */
function TokenDialogFor({
  server,
  openedOn,
  entry,
  onClose,
}: {
  readonly server: McpServer;
  readonly openedOn: "server-page" | "elsewhere";
  readonly entry: SignInEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { attempt, state } = useUrlServerAttempt({
    kind: "token",
    mcpServerId: server.id,
    name: server.name,
  });
  const dialog: UrlServerDialog = { kind: "token", server, openedOn, entry };
  // The title stays what the dialog opened with: a server that moves onto a Connection while
  // the dialog is open changes the record, not what the user asked for.
  const [heading] = useState(() => describeUrlServerDialogTitle(dialog));
  // Ends the attempt before the dialog closes, so no late result reaches it.
  const close = (): void => {
    attempt.close();
    dialogRef.current?.close();
  };
  return (
    <UrlServerDialogFrame
      dialogRef={dialogRef}
      heading={heading}
      onClose={() => {
        attempt.close();
        onClose();
      }}
      onCloseRequest={close}
    >
      <StepView
        step={describeUrlServerStep(state, dialog)}
        attempt={attempt}
        onClose={close}
        onOpenServer={(mcpServerId) => {
          close();
          void navigate({ to: "/settings/mcp-servers/$id", params: { id: mcpServerId } });
        }}
      />
    </UrlServerDialogFrame>
  );
}
