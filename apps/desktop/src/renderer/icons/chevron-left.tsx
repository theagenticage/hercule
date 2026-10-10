import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the chevron-left icon: an angle pointing left. */
export function ChevronLeftIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M9.8 3.8L5.6 8l4.2 4.2" />
    </IconFrame>
  );
}
