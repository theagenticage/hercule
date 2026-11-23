import { Suspense, type JSX } from "react";
import { listConnectionTypes } from "@hercule/client-core";
import type { McpServerView, SignInEntry } from "@hercule/client-core/mcp-servers";
import { LazyConnectionSetupDialog } from "../../../../../screens/settings/connections/lazy-connection-setup-dialog";
import { LazyTokenDialog } from "../../../../../screens/settings/mcp-servers/lazy-token-dialog";

/**
 * Renders the dialogs a server's page opens from its status band and its
 * sign-in row, and nothing while neither is open.
 *
 * - The token dialog is the page's one sign-in for a server added by URL. It
 *   opens on `signingIn`, the button that asked for it ("Replace token…" or
 *   "Sign in again…"), and `onCloseSignIn` is called when it closes.
 * - The Connection setup dialog opens while `reconnecting` is true, for a
 *   plugin's server whose Connection needs signing in again, and
 *   `onCloseReconnect` is called when it closes.
 */
export function ServerDialogs({
  view,
  plugins,
  signingIn,
  onCloseSignIn,
  reconnecting,
  onCloseReconnect,
}: {
  readonly view: McpServerView;
  readonly plugins: Parameters<typeof listConnectionTypes>[0];
  readonly signingIn: SignInEntry | null;
  readonly onCloseSignIn: () => void;
  readonly reconnecting: boolean;
  readonly onCloseReconnect: () => void;
}): JSX.Element {
  const connectionType = listConnectionTypes(plugins).find(
    (type) => type.type === view.connection?.type,
  );
  return (
    <>
      {signingIn !== null && (
        <Suspense fallback={null}>
          <LazyTokenDialog
            mcpServerId={view.server.id}
            openedOn="server-page"
            entry={signingIn}
            onClose={onCloseSignIn}
          />
        </Suspense>
      )}
      {reconnecting && view.connection !== undefined && connectionType !== undefined && (
        <Suspense fallback={null}>
          <LazyConnectionSetupDialog
            type={connectionType}
            connection={view.connection}
            onClose={onCloseReconnect}
          />
        </Suspense>
      )}
    </>
  );
}
