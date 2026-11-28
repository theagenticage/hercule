import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the desktop icon: a monitor on a short stand and foot. */
export function DesktopIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.4" y="2.6" width="11.2" height="7.8" rx="1.4" />
      <path d="M8 10.4V13M5.4 13.4h5.2" />
    </IconFrame>
  );
}
