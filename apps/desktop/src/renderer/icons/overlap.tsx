import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the overlap icon: two circles with their shared area filled. It
 * marks a Discussion that an Edit Overlap opened.
 */
export function OverlapIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="5.5" cy="8" r="4" />
      <circle cx="10.5" cy="8" r="4" />
      <path
        d="M8 4.9a4 4 0 0 1 0 6.2a4 4 0 0 1 0-6.2z"
        fill="currentColor"
        stroke="none"
        opacity=".45"
      />
    </IconFrame>
  );
}
