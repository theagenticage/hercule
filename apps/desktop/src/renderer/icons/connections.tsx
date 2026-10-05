import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the connections icon: a plug with two prongs and a cord. */
export function ConnectionsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6 2.6v2.6M10 2.6v2.6M4.2 5.2h7.6v2.4a3.8 3.8 0 0 1-7.6 0zM8 11.4v2.2" />
    </IconFrame>
  );
}
