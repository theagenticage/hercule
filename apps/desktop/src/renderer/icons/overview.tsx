import type { JSX } from "react";
import { OVERVIEW_ICON_OUTLINES } from "./app-icon-outlines";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the Overview icon: four squares in a grid. The Bureau book has no
 * such icon (see `app-icon-outlines.ts`).
 */
export function OverviewIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      {OVERVIEW_ICON_OUTLINES.map((outline) => (
        <path key={outline} d={outline} />
      ))}
    </IconFrame>
  );
}
