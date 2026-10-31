import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the grip icon: two columns of three dots, which marks something as draggable. */
export function GripIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="6" cy="4" r=".6" fill="currentColor" />
      <circle cx="10" cy="4" r=".6" fill="currentColor" />
      <circle cx="6" cy="8" r=".6" fill="currentColor" />
      <circle cx="10" cy="8" r=".6" fill="currentColor" />
      <circle cx="6" cy="12" r=".6" fill="currentColor" />
      <circle cx="10" cy="12" r=".6" fill="currentColor" />
    </IconFrame>
  );
}
