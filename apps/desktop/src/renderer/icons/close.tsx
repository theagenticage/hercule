import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the close icon: a cross. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </IconFrame>
  );
}
