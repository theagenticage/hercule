import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the info icon: a lower-case i in a circle. The Bureau book has no
 * info icon, so this one is drawn on the same 16-unit grid as the question
 * icon, with the dot where that icon puts its own, mirrored to the top.
 */
export function InfoIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v4.2" />
      <circle cx="8" cy="4.8" r=".4" fill="currentColor" />
    </IconFrame>
  );
}
