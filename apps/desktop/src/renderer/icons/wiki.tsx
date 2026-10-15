import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the wiki icon: an open book. */
export function WikiIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 4.4C6.6 3.4 4.6 3 2.4 3.2v9.2c2.2-.2 4.2.2 5.6 1.2 1.4-1 3.4-1.4 5.6-1.2V3.2C11.4 3 9.4 3.4 8 4.4z" />
      <path d="M8 4.4v9.2" />
    </IconFrame>
  );
}
