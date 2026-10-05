import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the user icon: a head and shoulders. */
export function UserIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="5.6" r="2.8" />
      <path d="M2.8 13.6c.6-2.8 2.6-4.4 5.2-4.4s4.6 1.6 5.2 4.4" />
    </IconFrame>
  );
}
