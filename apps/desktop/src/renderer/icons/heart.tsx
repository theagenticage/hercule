import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the heart icon: a pulse line, as a heart monitor draws a beat. */
export function HeartIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.2 8.2h2.6l1.4-3 2.2 6 1.6-3.4h3.8" />
    </IconFrame>
  );
}
