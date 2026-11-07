import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the lock icon: a closed padlock. It is drawn as the Bureau book's
 * lock, which the pages that show a place the user cannot open use.
 */
export function LockIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="3.4" y="7" width="9.2" height="6.6" rx="1.8" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
    </IconFrame>
  );
}
