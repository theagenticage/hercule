import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the sidebar icon: a window with its left pane divided off. */
export function SidebarIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" />
      <path d="M6.2 2.8v10.4" />
    </IconFrame>
  );
}
