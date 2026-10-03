import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the check icon: a check mark. */
export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.4 8.4l3 3 6.2-6.6" />
    </IconFrame>
  );
}
