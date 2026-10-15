import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the discussions icon: two speech bubbles, one behind the other. */
export function DiscussionsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 4a1.6 1.6 0 0 1 1.6-1.6h5.4A1.6 1.6 0 0 1 11 4v3.2a1.6 1.6 0 0 1-1.6 1.6H6.2L3.8 10.6V8.8A1.6 1.6 0 0 1 2.4 7.2z" />
      <path d="M11 5.6h1a1.6 1.6 0 0 1 1.6 1.6v3.2A1.6 1.6 0 0 1 12.2 12v1.8L9.8 12H8.2a1.6 1.6 0 0 1-1.6-1.6v-.2" />
    </IconFrame>
  );
}
