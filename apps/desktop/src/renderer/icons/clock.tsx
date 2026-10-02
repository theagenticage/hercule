import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the clock icon: a dial with its two hands. */
export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2 1.4" />
    </IconFrame>
  );
}
