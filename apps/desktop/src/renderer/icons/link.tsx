import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the link icon: two links of a chain, for what is linked to something. */
export function LinkIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6" />
    </IconFrame>
  );
}
