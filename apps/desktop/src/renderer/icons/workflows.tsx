import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the workflows icon: three nodes, two of them joined to the third. */
export function WorkflowsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="4" cy="4" r="1.7" />
      <circle cx="12" cy="8" r="1.7" />
      <circle cx="4" cy="12" r="1.7" />
      <path d="M5.7 4.4c3 .4 3.2 3.2 4.6 3.6M5.7 11.6c3-.4 3.2-3.2 4.6-3.6" />
    </IconFrame>
  );
}
