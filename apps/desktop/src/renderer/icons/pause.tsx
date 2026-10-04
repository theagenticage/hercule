import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the pause icon: two upright bars. */
export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6 4v8M10 4v8" />
    </IconFrame>
  );
}
