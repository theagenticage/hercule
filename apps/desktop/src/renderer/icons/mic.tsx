import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the microphone icon: a capsule in its stand. */
export function MicIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="5.8" y="2" width="4.4" height="7.6" rx="2.2" />
      <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2" />
    </IconFrame>
  );
}
