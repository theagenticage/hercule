import { Suspense, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listConnectionTypes } from "@hercule/client-core";
import { connectionsQuery, pluginsQuery } from "../../app/queries";
import { LazyConnectionSetupDialog } from "../settings/connections/lazy-connection-setup-dialog";

/**
 * Renders the Reconnect dialog of the Connection `connectionId`, the one
 * Settings > Connections opens, for a thread's button that fixes a server
 * needing sign-in. The dialog's code loads the first time it renders.
 * Draws nothing when the Connection or its type is gone since the button was
 * drawn. `onClose` is called whenever the dialog closes, and the caller then
 * unmounts it.
 */
export function ReconnectDialog({
  connectionId,
  onClose,
}: {
  readonly connectionId: string;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const connection = useSuspenseQuery(connectionsQuery(client)).data.find(
    (each) => each.id === connectionId,
  );
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const type = listConnectionTypes(plugins).find((each) => each.type === connection?.type);
  if (connection === undefined || type === undefined) return null;
  return (
    // Without its own boundary, the dialog's load would suspend the screen behind it.
    <Suspense fallback={null}>
      <LazyConnectionSetupDialog type={type} connection={connection} onClose={onClose} />
    </Suspense>
  );
}
