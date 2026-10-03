import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the key icon: a ring and a bit with two teeth. */
export function KeyIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="5.4" cy="10.6" r="2.8" />
      <path d="M7.4 8.6l5.4-5.4M11 4.8l1.6 1.6M9.6 6.2l1.2 1.2" />
    </IconFrame>
  );
}
