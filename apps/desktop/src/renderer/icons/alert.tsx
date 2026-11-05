import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the alert icon: an exclamation mark in a circle. The Bureau book
 * has no alert icon, so this one is the info icon turned upside down: the
 * same circle, stroke and dot, with the dot at the bottom.
 */
export function AlertIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.6v4.2" />
      <circle cx="8" cy="11.2" r=".4" fill="currentColor" />
    </IconFrame>
  );
}
