import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the workspace icon: a folder. */
export function WorkspaceIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 4.2a1 1 0 0 1 1-1h3l1.4 1.6h4.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" />
    </IconFrame>
  );
}
