import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the sparkle icon: a four-pointed star with curved sides. */
export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.4c.5 2.9 2.7 5.1 5.6 5.6-2.9.5-5.1 2.7-5.6 5.6-.5-2.9-2.7-5.1-5.6-5.6 2.9-.5 5.1-2.7 5.6-5.6z" />
    </IconFrame>
  );
}
