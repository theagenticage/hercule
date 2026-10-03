import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

/** Renders the tasks icon: a check mark in a rounded square. */
export function TasksIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3" />
      <path d="M5.4 8.2l1.8 1.7 3.4-3.6" />
    </IconFrame>
  );
}
