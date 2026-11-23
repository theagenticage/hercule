import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  describeClosing,
  describeExistsRefusal,
  describePluginOriginRefusal,
  describeTokenForm,
  readAddForm,
  type RefusalAction,
  type RefusalDescription,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import {
  buildSignInActions,
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
 * is closed after it, and the dialog says so. The fields are this dialog's;
 * the attempt (see `useUrlServerAttempt`) holds the write and follows the
 * server. `onClose` is called whenever the dialog closes; the list then
 * unmounts it.
 */
export function AddServerDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { flows, attemptId, state } = useUrlServerAttempt({ kind: "add" });
  const check = useCheckNow();
  const [address, setAddress] = useState("");
  // `null` until the user types in the Name: the field then follows the address.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [token, setToken] = useState("");
  // The fields the last "Check server" sent. A refusal is about those, not about what is typed now.
  const [sent, setSent] = useState<string | null>(null);
  const fields = JSON.stringify([address, typedName]);
  const close = (): void => dialogRef.current?.close();
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
    const described = describePluginOriginRefusal({
      refusal: problem.refusal,
      message: problem.message,
      plugins,
      connections,
    });
    // This app has no Plugins page to open yet, so the sentence stands without a button.
    return described.action?.kind === "open-plugins" ? { ...described, action: null } : described;
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
        return;
    }
  };

  return (
    <UrlServerDialogFrame dialogRef={dialogRef} heading="Add an MCP server" onClose={onClose}>
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
              ? describeTokenForm(state.server)
              : null
          }
          token={token}
          closingNote={describeClosing(state)}
          checkBusy={check.busy}
          checkError={check.error}
          actions={{
            onClose: close,
            onOpenServer: openServer,
            onCheckNow: () => {
              if (state.kind === "following") check.run(state.mcpServerId);
            },
            onRetryRead: () => {
              if (attemptId !== null) flows.retryRead(attemptId);
            },
            onTokenChange: setToken,
            onSaveToken: () => {
              if (attemptId !== null) flows.submitToken(attemptId, token);
            },
            ...buildSignInActions(flows, attemptId),
          }}
        />
      )}
    </UrlServerDialogFrame>
  );
}
