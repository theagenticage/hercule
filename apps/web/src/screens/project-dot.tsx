import type { JSX } from "react";
import { projectTone } from "@hydra/client-core";
import { cn } from "@hydra/ui";

/**
 * A project's identity dot: a small square in one of the two identity hues the
 * design language fixes (§Color doctrine, §Lineage - "on group headers only,
 * never per row"). Which hue a project wears is `projectTone`'s to say.
 *
 * The class names are written out rather than built, because a class the
 * stylesheet has never seen written is a class Tailwind never emits.
 */
const TONE = {
  hydra: "bg-project-hydra",
  ops: "bg-project-ops",
} as const;

export function ProjectDot({
  projectId,
  className,
}: {
  readonly projectId: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span aria-hidden="true" className="flex w-2.5 shrink-0 justify-center">
      <span className={cn("size-[7px] rounded-[2px]", TONE[projectTone(projectId)], className)} />
    </span>
  );
}
