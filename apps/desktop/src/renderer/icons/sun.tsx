import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the sun icon: a small circle with eight short rays, for the day theme. */
export function SunIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
    </IconFrame>
  );
}
