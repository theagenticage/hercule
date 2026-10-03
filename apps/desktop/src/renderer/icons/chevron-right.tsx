import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the chevron-right icon: an angle pointing right. */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6.2 3.8L10.4 8l-4.2 4.2" />
    </IconFrame>
  );
}
