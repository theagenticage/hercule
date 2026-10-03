import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the Intake icon: an inbox tray. */
export function IntakeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 9.2h3.2l1 1.8h2.8l1-1.8h3.2" />
      <path d="M2.4 9.2l1.6-5.4h8l1.6 5.4v3.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" />
    </IconFrame>
  );
}
