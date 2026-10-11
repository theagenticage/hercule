import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the diff icon: a plus above a minus. */
export function DiffIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5 2.6v6M2 5.6h6M8.6 11.8H14" />
    </IconFrame>
  );
}
