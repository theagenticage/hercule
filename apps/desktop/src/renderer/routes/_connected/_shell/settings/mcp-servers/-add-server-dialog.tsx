import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  describeClosing,
  describeExistsRefusal,
  describeOpenServerAction,
  describePluginOriginRefusal,
  readAddForm,
  type RefusalAction,
  type RefusalDescription,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import {
  buildSignInActions,
  describeAttemptTokenForm,
  useCheckNow,
  useUrlServerAttempt,
} from "../../../../../app/mcp-url-flows";
import { connectionsQuery, pluginsQuery } from "../../../../../app/queries";
import { showOfferRow } from "../../../../../screens/settings/mcp-servers/server-list";
import {
  AddForm,
  FlowBody,
  UrlServerDialogFrame,
} from "../../../../../screens/settings/mcp-servers/url-server-dialog-parts";

/**
 * Renders the Add by URL dialog of Settings > MCP servers (spec 17 §Adding and
 * replacing): the Address and the Name, "Check server" (which creates the
 * server), then the token step, the check's outcome, and the done step. The
 * controller's refusals of an address that is added already, or that a plugin
 * offers, show in the form with their button.
 *
 * The server is created by the check, so it stays in the list when the dialog
 * is closed after it, and the dialog says so. The address and the name are
 * this dialog's; the token is the token form's. The attempt (see
 * `useUrlServerAttempt`) holds the write and follows the server. `onClose` is called whenever the dialog closes; the list then
 * unmounts it.
 */
export function AddServerDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { flows, attemptId, state, closeAttempt } = useUrlServerAttempt({ kind: "add" });
  const check = useCheckNow(flows, attemptId);
  const [address, setAddress] = useState("");
  // `null` until the user types in the Name: the field then follows the address.
  const [typedName, setTypedName] = useState<string | null>(null);
  // The fields the last "Check server" sent. A refusal is about those, not about what is typed now.
  const [sent, setSent] = useState<string | null>(null);
  const fields = JSON.stringify([address, typedName]);
  // Ends the attempt before the dialog closes, so no late result reaches it.
  const close = (): void => {
    closeAttempt();
    dialogRef.current?.close();
  };
  const openServer = (mcpServerId: string): void => {
    close();
    void navigate({ to: "/settings/mcp-servers/$id", params: { id: mcpServerId } });
  };
  const reading = readAddForm({ address, typedName });

  const describeRefusal = (current: UrlServerFlowState): RefusalDescription | null => {
    if (current.kind !== "form" || current.problem === null || sent !== fields) return null;
    const { problem } = current;
    if (problem.kind === "exists")
      return describeExistsRefusal(problem.mcpServerId, problem.existing);
    if (problem.kind !== "plugin-origin") return null;
    // This app has no Plugins page, so a plugin that is off gets a sentence that says where
    // to act, and no button.
    return describePluginOriginRefusal({
      refusal: problem.refusal,
      message: problem.message,
      plugins,
      connections,
      pluginsSettings: "web-app",
    });
  };
  const runRefusalAction = (action: RefusalAction): void => {
    switch (action.kind) {
      case "open-server":
        openServer(action.mcpServerId);
        return;
      case "open-offer-row":
        close();
        showOfferRow(action.contributionId, action.connectionId);
        return;
      case "open-connections":
        close();
        void navigate({ to: "/settings/connections" });
        return;
      case "open-plugins":
        // Not offered here: `describePluginOriginRefusal` is asked for the app without a Plugins page.
        return;
    }
  };

  return (
    <UrlServerDialogFrame
      dialogRef={dialogRef}
      heading="Add an MCP server"
      onClose={() => {
        closeAttempt();
        onClose();
      }}
      onCloseRequest={close}
    >
      {state.kind === "form" ? (
        <AddForm
          address={address}
          typedName={typedName}
          reading={reading}
          problem={sent === fields ? state.problem : null}
          refusal={describeRefusal(state)}
          onAddressChange={setAddress}
          onNameChange={setTypedName}
          onSubmit={() => {
            if (attemptId === null) return;
            setSent(fields);
            flows.submitAdd(attemptId, { address, typedName });
          }}
          onRefusalAction={runRefusalAction}
          onCancel={close}
        />
      ) : (
        <FlowBody
          state={state}
          tokenWords={
            state.kind === "following" && state.server !== null
              ? describeAttemptTokenForm(state.server, state)
              : null
          }
          openAction={describeOpenServerAction(state, "elsewhere")}
          closingNote={describeClosing(state)}
          checkBusy={check.busy}
          checkError={check.error}
          actions={{
            onClose: close,
            onOpenServer: openServer,
            onCheckNow: check.run,
            onRetryRead: () => {
              if (attemptId !== null) flows.retryRead(attemptId);
            },
            onSaveToken: (token) => {
              if (attemptId !== null) flows.submitToken(attemptId, token);
            },
            ...buildSignInActions(flows, attemptId),
          }}
        />
      )}
    </UrlServerDialogFrame>
  );
}
