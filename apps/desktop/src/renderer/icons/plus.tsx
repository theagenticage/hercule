import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the plus icon. */
export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </IconFrame>
  );
}
