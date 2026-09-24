import type { JSX } from "react";
import type { ProjectTone } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * The background class per identity hue. The class names are written out in
 * full rather than built from parts, because Tailwind only generates classes
 * it finds written in the source.
 */
const TONE = {
  hercule: "bg-project-hercule",
  ops: "bg-project-ops",
} as const;

/**
 * A project's identity dot: a small square in one of the two identity hues
 * set by the design language (§Color doctrine, §Lineage - "on group headers
 * only, never per row"). `pickProjectTone` decides a project's hue, and the
 * caller calls it where the projects are listed: the hue depends on the
 * project's position among the others, which the dot alone does not know.
 */
export function ProjectDot({
  tone,
  className,
}: {
  readonly tone: ProjectTone;
  readonly className?: string;
}): JSX.Element {
  return (
    <span aria-hidden="true" className="flex w-2.5 shrink-0 justify-center">
      <span className={cn("size-[7px] rounded-[2px]", TONE[tone], className)} />
    </span>
  );
}
