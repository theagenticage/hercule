import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the question icon: a question mark in a circle. */
export function QuestionIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.6" />
      <circle cx="8" cy="11.4" r=".4" fill="currentColor" />
    </IconFrame>
  );
}
