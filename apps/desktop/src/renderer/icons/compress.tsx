import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the compress icon: two arrows pointing at each other across a
 * level line. The Bureau book has no compress icon, so this one is drawn on
 * the same 16-unit grid as the others.
 */
export function CompressIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3 8h10" />
      <path d="M8 2.2v3.6M5.8 3.6l2.2 2.2 2.2-2.2" />
      <path d="M8 13.8v-3.6M5.8 12.4l2.2-2.2 2.2 2.2" />
    </IconFrame>
  );
}
