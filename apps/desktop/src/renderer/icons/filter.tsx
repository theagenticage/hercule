import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the filter icon: three lines, each shorter than the one above. */
export function FilterIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.6 3.6h10.8M4.6 8h6.8M6.6 12.4h2.8" />
    </IconFrame>
  );
}
