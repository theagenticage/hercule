import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the flag icon, filled, which stands for an Initiative. It comes
 * from the Overview's drawing, not from the Bureau book.
 */
export function FlagIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path
        fill="currentColor"
        stroke="none"
        d="M4 2.2a.8.8 0 0 1 .8.8v.3h7.4c.5 0 .8.6.5 1L10.9 7l1.8 2.7c.3.4 0 1-.5 1H4.8V14a.8.8 0 0 1-1.6 0V3a.8.8 0 0 1 .8-.8Z"
      />
    </IconFrame>
  );
}
