import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the arrow icon: an arrow pointing right. */
export function ArrowIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3 8h9.4M8.8 4.4L12.4 8l-3.6 3.6" />
    </IconFrame>
  );
}
