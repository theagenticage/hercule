import type { JSX } from "react";
import type { MachineKind } from "@hercule/client-core/fleet";
import { DesktopIcon } from "../../icons/desktop";
import type { IconProps } from "../../icons/icon-frame";
import { LaptopIcon } from "../../icons/laptop";
import { ServerIcon } from "../../icons/server";

/** Renders the icon of a machine of `kind`: a laptop, a desktop or a server. It takes the size every icon takes. */
export function MachineIcon({
  kind,
  ...iconProps
}: IconProps & { readonly kind: MachineKind }): JSX.Element {
  switch (kind) {
    case "laptop":
      return <LaptopIcon {...iconProps} />;
    case "desktop":
      return <DesktopIcon {...iconProps} />;
    case "server":
      return <ServerIcon {...iconProps} />;
  }
}
