import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the cpu icon: a chip with two pins on each side. */
export function CpuIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.6" />
      <path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2" />
    </IconFrame>
  );
}
