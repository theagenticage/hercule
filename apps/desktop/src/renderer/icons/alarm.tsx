import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the alarm icon: a clock with two bells above it. */
export function AlarmIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8.8" r="4.8" />
      <path d="M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.4M13.4 3.6l-1.8-1.4" />
    </IconFrame>
  );
}
