import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the play icon: a triangle pointing right, for starting a run. */
export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5.4 3.6v8.8L12.2 8z" />
    </IconFrame>
  );
}
