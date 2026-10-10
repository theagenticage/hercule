import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the minus icon: one level stroke, the plus icon without its
 * upright. A workflow's graph draws it on the zoom-out button. Not in the
 * Bureau book yet: a proposed addition.
 */
export function MinusIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.2 8h9.6" />
    </IconFrame>
  );
}
