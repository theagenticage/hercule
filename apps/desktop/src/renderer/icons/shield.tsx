import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the shield icon: a shield with a check mark. */
export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.2l4.8 1.8v3.8c0 3-2.2 5.2-4.8 6-2.6-.8-4.8-3-4.8-6V4z" />
      <path d="M5.8 8.2l1.6 1.5 2.8-3" />
    </IconFrame>
  );
}
