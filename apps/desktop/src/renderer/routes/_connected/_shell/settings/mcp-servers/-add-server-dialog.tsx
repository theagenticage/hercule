import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  describeUrlServerDialogTitle,
  describeUrlServerStep,
  readAddForm,
  type RefusalAction,
  type UrlServerDialog,
} from "@hercule/client-core/mcp-servers";
import { useUrlServerAttempt } from "../../../../../app/mcp-url-flows";
import { connectionsQuery, pluginsQuery } from "../../../../../app/queries";
import { showOfferRow } from "../../../../../screens/settings/mcp-servers/server-list";
import {
  AddForm,
  StepView,
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
 * `useUrlServerAttempt`) holds the write, follows the server, and keeps a
 * refusal only while the fields are as they were when it was made. `onClose` is called whenever the dialog closes; the list then
 * unmounts it.
 */
export function AddServerDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { attempt, state } = useUrlServerAttempt({ kind: "add" });
  const [address, setAddress] = useState("");
  // `null` until the user types in the Name: the field then follows the address.
  const [typedName, setTypedName] = useState<string | null>(null);
  // This app has no Plugins page, so a plugin that is off gets a sentence that says where to act,
  // and no button.
  const dialog: UrlServerDialog = { kind: "add", plugins, connections, pluginsSettings: "web-app" };
  const [heading] = useState(() => describeUrlServerDialogTitle(dialog));
  const step = describeUrlServerStep(state, dialog);
  // Ends the attempt before the dialog closes, so no late result reaches it.
  const close = (): void => {
    attempt.close();
    dialogRef.current?.close();
  };
  const openServer = (mcpServerId: string): void => {
    close();
    void navigate({ to: "/settings/mcp-servers/$id", params: { id: mcpServerId } });
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
        // Not offered here: `pluginsSettings` of the dialog says this app has no Plugins page.
        return;
    }
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
      {step.kind === "add-form" ? (
        <AddForm
          step={step}
          address={address}
          typedName={typedName}
          reading={readAddForm({ address, typedName })}
          onAddressChange={(next) => {
            setAddress(next);
            attempt.changeFields({ address: next, typedName });
          }}
          onNameChange={(next) => {
            setTypedName(next);
            attempt.changeFields({ address, typedName: next });
          }}
          onSubmit={() => {
            attempt.submitAdd({ address, typedName });
          }}
          onRefusalAction={runRefusalAction}
          onCancel={close}
        />
      ) : (
        <StepView step={step} attempt={attempt} onClose={close} onOpenServer={openServer} />
      )}
    </UrlServerDialogFrame>
  );
}
