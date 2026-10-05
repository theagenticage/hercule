import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the puzzle icon: a puzzle piece with a knob on its top and right sides. */
export function PuzzleIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3 5.2h2.6a1.4 1.4 0 1 1 2.8 0H11v2.6a1.4 1.4 0 1 1 0 2.8v2.6H3z" />
    </IconFrame>
  );
}
