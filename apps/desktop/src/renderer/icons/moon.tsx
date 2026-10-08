import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the moon icon: a crescent, for the night theme. */
export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M12.8 9.8A5.4 5.4 0 0 1 6.2 3.2a5.4 5.4 0 1 0 6.6 6.6z" />
    </IconFrame>
  );
}
