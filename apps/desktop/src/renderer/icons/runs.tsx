import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the runs icon: a rounded square around a play triangle. */
export function RunsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3.2" />
      <path d="M6.6 5.6v4.8L10.4 8z" />
    </IconFrame>
  );
}
