import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the terminal icon: a window with a prompt and a cursor. */
export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="2" />
      <path d="M4.8 6.2l2 1.8-2 1.8M8.4 10h2.8" />
    </IconFrame>
  );
}
