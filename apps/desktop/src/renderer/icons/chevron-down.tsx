import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the chevron-down icon: an angle pointing down. */
export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.8 6.2L8 10.4l4.2-4.2" />
    </IconFrame>
  );
}
