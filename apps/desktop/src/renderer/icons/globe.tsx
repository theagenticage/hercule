import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the globe icon: a circle crossed by the equator and one meridian. */
export function GlobeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.4 8h11.2M8 2.2c-2.6 3.4-2.6 8.2 0 11.6M8 2.2c2.6 3.4 2.6 8.2 0 11.6" />
    </IconFrame>
  );
}
