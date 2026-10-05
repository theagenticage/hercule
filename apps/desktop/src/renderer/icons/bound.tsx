import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the bound icon: four bars of different heights on a baseline. */
export function BoundIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 12.4h11.2M4 12.4V8.6M7 12.4V5.4M10 12.4V7.2M13 12.4V3.6" />
    </IconFrame>
  );
}
