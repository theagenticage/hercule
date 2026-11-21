import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the tools icon: a wrench, for the tools an MCP server gives agents.
 * The Bureau book drew no such icon, so this one was drawn for the MCP
 * servers prototype (#1211).
 */
export function ToolsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M11.38 2.57L9.11 4.84a.6.6 0 0 0 0 .84l1.21 1.21a.6.6 0 0 0 .84 0l2.27-2.27a3.7 3.7 0 0 1-4.81 4.81l-3.75 3.75a1.45 1.45 0 0 1-2.05-2.05l3.75-3.75a3.7 3.7 0 0 1 4.81-4.81z" />
    </IconFrame>
  );
}
