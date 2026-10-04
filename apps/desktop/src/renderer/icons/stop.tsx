import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the stop icon: a filled square with rounded corners. */
export function StopIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}
