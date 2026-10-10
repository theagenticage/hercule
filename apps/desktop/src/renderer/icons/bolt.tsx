import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the bolt icon: a lightning bolt, for a trigger that fires on an event. */
export function BoltIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8.8 2L4 9h3.6L7 14l5-7H8.4z" />
    </IconFrame>
  );
}
