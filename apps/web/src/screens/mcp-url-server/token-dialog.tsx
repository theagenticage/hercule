import type { JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import { describeClosing, describeSignInHeading } from "@hercule/client-core/mcp-servers";
import { useUrlServerFlow } from "../../app/mcp-url-server-flow";
import { ModalDialog } from "../modal-dialog";
import { FollowSteps } from "./follow-steps";
import { TokenForm } from "./token-form";

/**
 * The sign-in dialog of a server added by URL: one form for the page's
 * "Replace token…" and "Sign in again…", the band's "Sign in…" and the "Sign
 * in…" of a thread's lines and menu. It signs in through the browser when the
 * server offers it, or writes the pasted token with `mcpServer.setToken`, then
 * follows the server while the controller checks it again (see
 * `FollowSteps`), so it says whether the sign-in worked.
 *
 * `server` is the record the button was drawn from. The dialog reads a newer
 * one once it has written.
 */
export function TokenDialog({
  client,
  server,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly server: McpServer;
  readonly onClose: () => void;
}): JSX.Element {
  const flow = useUrlServerFlow(client, {
    kind: "token",
    mcpServerId: server.id,
    name: server.name,
  });
  const { state } = flow;
  return (
    <ModalDialog title={describeSignInHeading(server)} onClose={onClose}>
      {state.kind === "form" ? (
        <TokenForm
          server={server}
          problem={state.problem}
          refusal={null}
          closingNote={describeClosing(state)}
          onSubmit={flow.submitToken}
          onSignIn={flow.startSignIn}
          onCancel={onClose}
        />
      ) : (
        <FollowSteps
          client={client}
          flow={flow}
          state={state}
          fallbackServer={server}
          openServer={false}
          onClose={onClose}
        />
      )}
    </ModalDialog>
  );
}
