import { Suspense, useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listConnectionTypes } from "@hercule/client-core";
import { connectionsQuery, pluginsQuery } from "../../app/queries";
import { ConfirmDialog } from "../confirm-dialog";
import { LazyConnectionSetupDialog } from "../settings/connections/lazy-connection-setup-dialog";

/**
 * Renders the Reconnect dialog of the Connection `connectionId`, the one
 * Settings > Connections opens, for a thread's button that fixes a server
 * needing sign-in. The dialog's code loads the first time it renders.
 * When the Connection or its type is gone, since the button was drawn or
 * while the dialog was open, it shows a dialog that says which, with only a
 * Close button. `onClose` is called whenever the dialog closes, and the caller
 * then unmounts it.
 */
export function ReconnectDialog({
  connectionId,
  onClose,
}: {
  readonly connectionId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const connection = useSuspenseQuery(connectionsQuery(client)).data.find(
    (each) => each.id === connectionId,
  );
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const type = listConnectionTypes(plugins).find((each) => each.type === connection?.type);
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (connection === undefined || type === undefined) {
    return (
      <ConfirmDialog
        dialogRef={dialogRef}
        title="Reconnect"
        actionLabel="Reconnect"
        actionClass="accent"
        closeLabel="Close"
        refusal={
          connection === undefined
            ? "This Connection was deleted elsewhere, so it cannot be reconnected."
            : "The plugin of this Connection is no longer installed, so it cannot be reconnected."
        }
        onConfirm={onClose}
        onClose={onClose}
      >
        <p>{"Settings > Connections lists the Connections that exist."}</p>
      </ConfirmDialog>
    );
  }
  return (
    // Without its own boundary, the dialog's load would suspend the screen behind it.
    <Suspense fallback={null}>
      <LazyConnectionSetupDialog type={type} connection={connection} onClose={onClose} />
    </Suspense>
  );
}
