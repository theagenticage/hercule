import type { JSX } from "react";
import type { ConnectionType, PluginIdentity } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";

/** STUB - replaced by the table slice. */
export function ConnectionTable(_props: {
  readonly connections: ReadonlyArray<Connection>;
  readonly types: ReadonlyArray<ConnectionType>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** Reconnect is offered only while the Connection's type is in the binary. */
  readonly onReconnect: (connection: Connection, type: ConnectionType) => void;
  readonly onConfigure: (connection: Connection) => void;
  readonly onDelete: (connection: Connection) => void;
}): JSX.Element {
  return <></>;
}
