import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the palette icon: a painter's palette with three filled dots of paint. */
export function PaletteIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.2a5.8 5.8 0 0 0 0 11.6c1 0 1.4-.6 1.4-1.3 0-1.2-1-1.3-1-2.3 0-.8.6-1.3 1.4-1.3h1.6a2.6 2.6 0 0 0 2.6-2.6C14 4.6 11.4 2.2 8 2.2z" />
      <circle cx="5.2" cy="7.2" r=".6" fill="currentColor" />
      <circle cx="7.6" cy="4.8" r=".6" fill="currentColor" />
      <circle cx="10.6" cy="5.8" r=".6" fill="currentColor" />
    </IconFrame>
  );
}
