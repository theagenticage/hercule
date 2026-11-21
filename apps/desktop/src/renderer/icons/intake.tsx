import type { JSX } from "react";
import { INTAKE_ICON_OUTLINES } from "./app-icon-outlines";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the Intake icon: the Inbox's tray with an arrow coming down into
 * it. The Bureau book has no such icon (see `app-icon-outlines.ts`).
 */
export function IntakeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      {INTAKE_ICON_OUTLINES.map((outline) => (
        <path key={outline} d={outline} />
      ))}
    </IconFrame>
  );
}
