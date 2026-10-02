import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the branch icon: three commits, the side branch curving into the trunk. */
export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="4.6" cy="3.6" r="1.5" />
      <circle cx="4.6" cy="12.4" r="1.5" />
      <circle cx="11.4" cy="5.6" r="1.5" />
      <path d="M4.6 5.1v5.8M11.4 7.1c0 2.6-4.4 2.4-6.4 4" />
    </IconFrame>
  );
}
