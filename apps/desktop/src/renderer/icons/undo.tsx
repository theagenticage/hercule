import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the undo icon: an arrow that turns back on itself. */
export function UndoIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5.4 4.4L2.8 7l2.6 2.6" />
      <path d="M3 7h6.4a3.4 3.4 0 0 1 0 6.8H7" />
    </IconFrame>
  );
}
