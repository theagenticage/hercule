import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the external icon: an arrow leaving a box, for a link that opens outside the app. */
export function ExternalIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6.4 3.4H4a1.2 1.2 0 0 0-1.2 1.2V12A1.2 1.2 0 0 0 4 13.2h7.4a1.2 1.2 0 0 0 1.2-1.2V9.6M9 2.8h4.2V7M13 3l-5.6 5.6" />
    </IconFrame>
  );
}
