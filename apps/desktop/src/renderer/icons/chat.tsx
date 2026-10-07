import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the chat icon: a round speech bubble with its tail at the lower left. */
export function ChatIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 8a5.6 5 0 1 1 2.4 4.1L2.4 13l.7-2.4A4.8 4.8 0 0 1 2.4 8z" />
    </IconFrame>
  );
}
