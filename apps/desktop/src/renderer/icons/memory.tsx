import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the memory icon: a notebook with one line written on its cover. */
export function MemoryIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.4 2.8h7.4a1.8 1.8 0 0 1 1.8 1.8v8.6H5.2a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M3.4 11.4a1.8 1.8 0 0 1 1.8-1.8h7.4M6 5.4h4" />
    </IconFrame>
  );
}
