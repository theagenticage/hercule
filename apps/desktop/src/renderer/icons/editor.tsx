import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the editor icon: a slash between two angle brackets. */
export function EditorIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5.4 4.6L2.4 8l3 3.4M10.6 4.6l3 3.4-3 3.4M9.2 3.2L6.8 12.8" />
    </IconFrame>
  );
}
