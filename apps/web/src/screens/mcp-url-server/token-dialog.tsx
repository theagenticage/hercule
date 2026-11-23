import { useState, type JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import {
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  type SignInEntry,
  type UrlServerDialog,
} from "@hercule/client-core/mcp-servers";
import { useUrlServerAttempt } from "../../app/mcp-url-server-flow";
import { ModalDialog } from "../modal-dialog";
import { StepView } from "./step-view";

/**
 * The sign-in dialog of a server added by URL: one form for the page's
 * "Replace token…" and "Sign in again…", the band's "Sign in…" and the "Sign
 * in…" of a thread's lines and menu. It signs in through the browser when the
 * server offers it, or writes the pasted token with `mcpServer.setToken`, then
 * follows the server while the controller checks it again (see `StepView`), so
 * it shows whether the sign-in worked.
 *
 * `server` is the record the button was drawn from. The dialog reads a newer
 * one once it has written. `openedOn` is whether the dialog sits on the
 * server's own page, which decides whether "Open <name>" leads anywhere.
 * `entry` is the button that opened the dialog, which decides its first step
 * even when the record changes after the press.
 */
export function TokenDialog({
  client,
  server,
  openedOn,
  entry,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly server: McpServer;
  readonly openedOn: "server-page" | "elsewhere";
  readonly entry: SignInEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const { attempt, state } = useUrlServerAttempt(client, {
    kind: "token",
    mcpServerId: server.id,
    name: server.name,
  });
  const dialog: UrlServerDialog = { kind: "token", server, openedOn, entry };
  // The title stays what the dialog opened with: a server that moves onto a Connection while
  // the dialog is open changes the record, not what the user asked for.
  const [title] = useState(() => describeUrlServerDialogTitle(dialog));
  const step = describeUrlServerStep(state, dialog);
  return (
    <ModalDialog title={title} onClose={onClose}>
      <StepView step={step} attempt={attempt} onClose={onClose} />
    </ModalDialog>
  );
}
