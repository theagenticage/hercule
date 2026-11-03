import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the archive icon: a box with its lid and a slot for a handle. */
export function ArchiveIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.4" y="2.8" width="11.2" height="3.2" rx="1.2" />
      <path d="M3.4 6v6.2a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V6" />
      <path d="M6.4 8.8h3.2" />
    </IconFrame>
  );
}
