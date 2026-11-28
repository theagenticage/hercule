import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the folder icon, which stands for a Project. It comes from the
 * Overview's drawing, not from the Bureau book.
 */
export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.2 4.4c0-.7.6-1.2 1.2-1.2h2.7c.3 0 .6.1.8.4l1 1.2h4.7c.7 0 1.2.5 1.2 1.2v5.6c0 .7-.5 1.2-1.2 1.2H3.4c-.6 0-1.2-.5-1.2-1.2V4.4Z" />
    </IconFrame>
  );
}
