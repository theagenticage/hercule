/**
 * A project's tile: a small rug swatch in the project's tint, then the
 * project's name, as the Bureau book's `.proj` draws it. The sidebar's
 * project headings and the thread header's crumb draw it.
 */
import type { JSX } from "react";
import { pickProjectHue } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import "./project-tile.css";

/**
 * Bureau's three project tints, as the book's `.proj--<tint>` classes name
 * them.
 */
const PROJECT_TINTS = ["webshop", "payments", "ops"] as const;

export type ProjectTint = (typeof PROJECT_TINTS)[number];

/**
 * Returns the tint of the project `projectId`. The tint follows the project's
 * position in `projects`, the project list in its own order, so a project has
 * the same tint on every screen.
 */
export const pickProjectTint = (projectId: string, projects: readonly Project[]): ProjectTint =>
  pickProjectHue(projectId, projects, PROJECT_TINTS);

/**
 * Renders a project's tile in `tint`, followed by `name`. In a row that runs
 * out of room, a long name ellipsizes.
 *
 * A `null` tint is for the threads in no project: the tile is then only an
 * outline, in the same place and at the same size, so the name lines up with
 * the names of projects.
 */
export function ProjectTile({
  tint,
  name,
}: {
  readonly tint: ProjectTint | null;
  readonly name: string;
}): JSX.Element {
  return (
    <span className={`proj proj--${tint ?? "none"}`}>
      <span className="proj-name">{name}</span>
    </span>
  );
}
