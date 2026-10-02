import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the send icon: an arrow pointing up. */
export function SendIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 13V3.4M4 7.2L8 3.2l4 4" />
    </IconFrame>
  );
}
