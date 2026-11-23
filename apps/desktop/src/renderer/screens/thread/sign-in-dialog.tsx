import type { JSX } from "react";
import type { SignInAction } from "@hercule/client-core/mcp-servers";
import { TokenDialog } from "../settings/mcp-servers/token-dialog";
import { ReconnectDialog } from "./reconnect-dialog";

/**
 * Renders the dialog a thread's button opens to sign a server in: the
 * Connection's Reconnect dialog for a server reached with a Connection, the
 * token dialog for a server added by URL. `action` is what
 * `describeSignInAction` decided for the button. `onClose` is called whenever
 * the dialog closes, and the caller then unmounts it. The code loads the
 * first time a button opens it (see `LazySignInDialog`).
 */
export function SignInDialog({
  action,
  onClose,
}: {
  readonly action: SignInAction;
  readonly onClose: () => void;
}): JSX.Element {
  return action.kind === "reconnect" ? (
    <ReconnectDialog connectionId={action.connectionId} onClose={onClose} />
  ) : (
    <TokenDialog mcpServerId={action.mcpServerId} onClose={onClose} />
  );
}
