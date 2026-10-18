import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/**
 * Renders the skill icon: a page with a small four-pointed star at its top
 * right corner, for a skill's written instructions.
 *
 * PROTOTYPE (#731): the Bureau book draws no skill icon, so this one is
 * drawn for the Skills prototype. It is not in `index.ts` or the specimen
 * sheet yet; the build of Settings > Skills (#732) adds it to both.
 */
export function SkillIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8.4 2.8H4.8a1.2 1.2 0 0 0-1.2 1.2v8a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2V7.6" />
      <path d="M11.8 1.6c.2 1.1.9 1.8 2 2-1.1.2-1.8.9-2 2-.2-1.1-.9-1.8-2-2 1.1-.2 1.8-.9 2-2z" />
      <path d="M6 8.2h4M6 10.6h2.6" />
    </IconFrame>
  );
}
