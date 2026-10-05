import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the crew icon: two people side by side, the one on the right smaller. */
export function CrewIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="5.6" cy="6" r="2.4" />
      <circle cx="11" cy="6.8" r="2" />
      <path d="M1.8 13.2c.4-2.4 1.8-3.8 3.8-3.8s3.4 1.4 3.8 3.8M9.6 10a3 3 0 0 1 4.6 3" />
    </IconFrame>
  );
}
