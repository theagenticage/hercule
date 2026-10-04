import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the threads icon: a speech bubble with its tail at the bottom left. */
export function ThreadsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.6 4.4a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H7.4L4.4 13.4V11h-.2a1.6 1.6 0 0 1-1.6-1.6z" />
    </IconFrame>
  );
}
