import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";
import { INTAKE_ICON_OUTLINES } from "./intake-outlines";

/** Renders the Intake icon: an inbox tray. */
export function IntakeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      {INTAKE_ICON_OUTLINES.map((outline) => (
        <path key={outline} d={outline} />
      ))}
    </IconFrame>
  );
}
