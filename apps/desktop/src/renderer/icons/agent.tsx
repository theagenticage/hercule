import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the agent icon: an egg-shaped head with two eyes, the crew's face
 * reduced to a glyph. A workflow's graph draws it on an agent step, where a
 * face would make the step look like a thread. Not in the Bureau book yet: a
 * proposed addition.
 */
export function AgentIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.4c2.7 0 4.6 2.6 4.6 5.8 0 3-2 5.4-4.6 5.4s-4.6-2.4-4.6-5.4c0-3.2 1.9-5.8 4.6-5.8z" />
      <circle cx="6.4" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="9.6" cy="8" r=".9" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}
