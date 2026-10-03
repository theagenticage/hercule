import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the server icon: two stacked units, each with a light. */
export function ServerIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.4" />
      <rect x="2.4" y="9" width="11.2" height="4.4" rx="1.4" />
      <path d="M5 4.8h.1M5 11.2h.1" />
    </IconFrame>
  );
}
