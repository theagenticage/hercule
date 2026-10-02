import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the file icon: a sheet with its corner folded. */
export function FileIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M4 2.4h5l3 3v8.2H4z" />
      <path d="M9 2.4v3h3" />
    </IconFrame>
  );
}
