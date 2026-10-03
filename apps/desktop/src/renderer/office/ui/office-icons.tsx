/**
 * The icons the Office's panels draw that the app's icon set does not have
 * yet. Each path is the Bureau book's, from its crew.js, on the same
 * 16-unit frame as every app icon.
 */
import type { JSX } from "react";
import { IconFrame, type IconProps } from "../../icons/icon-frame";

/** Renders a chevron that points down, for a button that opens a menu. */
export function ChevronDownIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M3.8 6.2L8 10.4l4.2-4.2" />
    </IconFrame>
  );
}
