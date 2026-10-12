import type { JSX } from "react";
import type { ConnectionType } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";

/**
 * STUB - replaced by the setup slice. Renders the setup of a Connection of
 * `type` in a glass dialog, or, with `connection`, a fresh credential for it.
 */
export function ConnectionSetupDialog(_props: {
  readonly type: ConnectionType;
  /** The Connection being reconnected; absent when this sets up a new one. */
  readonly connection?: Connection;
  /** Called when the dialog closes, set up or not. The caller then unmounts it. */
  readonly onClose: () => void;
}): JSX.Element {
  return <></>;
}
