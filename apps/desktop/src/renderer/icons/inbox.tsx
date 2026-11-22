import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";
import { INBOX_ICON_OUTLINES } from "./inbox-outlines";

/** Renders the Inbox icon: an inbox tray. */
export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      {INBOX_ICON_OUTLINES.map((outline) => (
        <path key={outline} d={outline} />
      ))}
    </IconFrame>
  );
}
