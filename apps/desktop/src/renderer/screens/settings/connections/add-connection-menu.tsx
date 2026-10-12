import type { JSX } from "react";
import type { ConnectionType, PluginIdentity } from "@hercule/client-core";

/** STUB - replaced by the table slice. */
export function AddConnectionMenu(_props: {
  readonly types: ReadonlyArray<ConnectionType>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onPick: (type: ConnectionType) => void;
}): JSX.Element {
  return <></>;
}
