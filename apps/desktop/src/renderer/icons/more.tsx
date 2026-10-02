import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the more icon: three filled dots in a row. */
export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="3.6" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="12.4" cy="8" r=".6" fill="currentColor" />
    </IconFrame>
  );
}
