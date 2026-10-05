import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the system icon: a screen on a stand. */
export function SystemIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.2" y="2.8" width="11.6" height="8.2" rx="1.6" />
      <path d="M6 13.4h4M8 11v2.4" />
    </IconFrame>
  );
}
