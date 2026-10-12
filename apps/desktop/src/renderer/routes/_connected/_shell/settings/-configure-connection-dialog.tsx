import type { JSX } from "react";
import type { ConnectionType } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";

/** STUB - replaced by the configure slice. */
export function ConfigureConnectionDialog(_props: {
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  return <></>;
}
