import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the eye icon: an open eye with its pupil. */
export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </IconFrame>
  );
}
