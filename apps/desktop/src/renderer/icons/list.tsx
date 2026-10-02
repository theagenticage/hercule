import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the list icon: three lines, each after a filled dot. */
export function ListIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6 4.2h7.4M6 8h7.4M6 11.8h7.4" />
      <circle cx="3" cy="4.2" r=".5" fill="currentColor" />
      <circle cx="3" cy="8" r=".5" fill="currentColor" />
      <circle cx="3" cy="11.8" r=".5" fill="currentColor" />
    </IconFrame>
  );
}
