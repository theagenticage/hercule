import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the compose icon: a pencil writing on an open sheet. */
export function ComposeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M7.4 2.8H4.2a1.4 1.4 0 0 0-1.4 1.4v7.6a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V8.6" />
      <path d="M11.6 2.4l2 2-5.4 5.4-2.6.6.6-2.6z" />
    </IconFrame>
  );
}
