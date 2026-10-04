import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the search icon: a lens and its handle. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5l3 3" />
    </IconFrame>
  );
}
