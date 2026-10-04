import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the laptop icon: a screen above a base line. */
export function LaptopIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="3.4" y="3.4" width="9.2" height="6.6" rx="1.2" />
      <path d="M1.8 12.6h12.4" />
    </IconFrame>
  );
}
