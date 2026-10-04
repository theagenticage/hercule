import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the sliders icon: two lines, each with a knob. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3 5h5.4M11.6 5H13M3 11h1.4M7.6 11H13" />
      <circle cx="10" cy="5" r="1.6" />
      <circle cx="6" cy="11" r="1.6" />
    </IconFrame>
  );
}
