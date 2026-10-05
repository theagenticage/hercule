import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the id icon: an identity card with a portrait and two lines of text. */
export function IdIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2" y="3.4" width="12" height="9.2" rx="2" />
      <circle cx="6" cy="7.4" r="1.4" />
      <path d="M4 10.8c.4-1 1.2-1.6 2-1.6s1.6.6 2 1.6M9.6 6.6h2.6M9.6 9h2" />
    </IconFrame>
  );
}
