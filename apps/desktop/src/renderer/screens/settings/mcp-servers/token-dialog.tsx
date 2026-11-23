import { useRef, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { isNotFound, readErrorMessage } from "@hercule/client-core";
import {
  describeClosing,
  describeOpenServerAction,
  describeSignInHeading,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import {
  buildSignInActions,
  describeAttemptTokenForm,
  useCheckNow,
  useUrlServerAttempt,
} from "../../../app/mcp-url-flows";
import { mcpServerQuery } from "../../../app/queries";
import { WaitLine, Warning } from "../../step";
import { QuestionIcon } from "../../../icons/question";
import { FlowBody, TokenForm, UrlServerDialogFrame } from "./url-server-dialog-parts";

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
 * has no "Open <name>" button to offer, or `elsewhere`. `onClose` is called
 * whenever the dialog closes; the caller then unmounts it.
 */
export function TokenDialog({
  mcpServerId,
  openedOn,
  onClose,
}: {
  readonly mcpServerId: string;
  readonly openedOn: "server-page" | "elsewhere";
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const server = useQuery(mcpServerQuery(client, mcpServerId));
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (server.data !== undefined) {
    return <TokenDialogFor server={server.data} openedOn={openedOn} onClose={onClose} />;
  }
  const failure = server.error;
  return (
    <UrlServerDialogFrame dialogRef={dialogRef} heading="Sign in" onClose={onClose}>
      {failure === null ? (
        <WaitLine text="Reading the server…" />
      ) : (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            {isNotFound(failure) ? (
              <>
                <b>This server was removed.</b> There is nothing left to sign in to.
              </>
            ) : (
              <>
                <b>The server could not be read.</b> {readErrorMessage(failure)}
              </>
            )}
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
  onClose,
}: {
  readonly server: McpServer;
  readonly openedOn: "server-page" | "elsewhere";
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The attempt is kept by the server's id and the name it was opened with, so a rename
  // that arrives while the dialog is open never replaces the attempt and its sign-in.
  const [openedName] = useState(server.name);
  // The heading stays what the dialog opened with: a server that moves onto a Connection while
  // the dialog is open changes the record, not what the user asked for.
  const [heading] = useState(() => describeSignInHeading(server));
  const { flows, attemptId, state, closeAttempt } = useUrlServerAttempt({
    kind: "token",
    mcpServerId: server.id,
    name: openedName,
  });
  const check = useCheckNow(flows, attemptId);
  // Ends the attempt before the dialog closes, so no late result reaches it.
  const close = (): void => {
    closeAttempt();
    dialogRef.current?.close();
  };
  const actions = {
    onClose: close,
    onOpenServer: (mcpServerId: string) => {
      close();
      void navigate({ to: "/settings/mcp-servers/$id", params: { id: mcpServerId } });
    },
    onCheckNow: check.run,
    onRetryRead: () => {
      if (attemptId !== null) flows.retryRead(attemptId);
    },
    onSaveToken: (token: string) => {
      if (attemptId !== null) flows.submitToken(attemptId, token);
    },
    ...buildSignInActions(flows, attemptId),
  };
  // The words follow the record the attempt last read, which a check may have changed.
  const followed = state.kind === "following" ? (state.server ?? server) : server;
  const words = describeAttemptTokenForm(followed, state);
  return (
    <UrlServerDialogFrame
      dialogRef={dialogRef}
      heading={heading}
      onClose={() => {
        closeAttempt();
        onClose();
      }}
      onCloseRequest={close}
    >
      {state.kind === "form" ? (
        <TokenForm
          words={words}
          refusedReason={null}
          onSubmit={actions.onSaveToken}
          onSignIn={actions.onStartSignIn}
          onCancel={close}
        />
      ) : (
        <FlowBody
          state={state}
          tokenWords={words}
          openAction={describeOpenServerAction(state, openedOn)}
          closingNote={describeClosing(state)}
          checkBusy={check.busy}
          checkError={check.error}
          actions={actions}
        />
      )}
    </UrlServerDialogFrame>
  );
}
