import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the copy icon: a page in front of a second one. The Bureau book has
 * no copy icon, so this one is drawn on the same 16-unit grid as the others.
 */
export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.6" />
      <path d="M10.4 3.6v-.2a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4V9a1.4 1.4 0 0 0 1.4 1.4h.2" />
    </IconFrame>
  );
}
