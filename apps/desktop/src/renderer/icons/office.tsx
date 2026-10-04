import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the Office icon: a building with a door, standing on the ground. */
export function OfficeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 13.6h11.2M3.6 13.6V6.4L8 3l4.4 3.4v7.2" />
      <path d="M6.4 13.6v-3.4h3.2v3.4" />
    </IconFrame>
  );
}
