import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the wrap icon: a full line, then a line that turns back with an
 * arrow, then a short one. The Bureau book has no wrap icon, so this one is
 * drawn on the same 16-unit grid as the others.
 */
export function WrapIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.5 4h11" />
      <path d="M2.5 8h8.5a2.25 2.25 0 0 1 0 4.5H8" />
      <path d="M9.5 11L8 12.5 9.5 14" />
      <path d="M2.5 12.5H5" />
    </IconFrame>
  );
}
