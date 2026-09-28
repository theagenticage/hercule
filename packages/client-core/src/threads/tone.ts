/**
 * Picks the identity hue for a project. It is decided in one place so every
 * screen that shows a project (the picker, the sidebar headers, a draft's
 * heading) gives the same project the same hue.
 */
import type { Project } from "@hercule/contract";

/**
 * The identity hue of a project's dot. The design language defines two hues
 * (docs/design-language.md §Color doctrine), and they alternate: a hue tells
 * two neighbouring projects apart, it does not identify a project.
 *
 * That is why the hue follows the project's position in the project list, not
 * anything about the project itself. Hashing the id gave two projects the same
 * hue about half the time, and two neighbouring headers in the same colour is
 * exactly what the dot is meant to prevent. Every screen reads the same list
 * from `project.query`, so a project has the same hue on all of them.
 */
export type ProjectTone = "hercule" | "ops";

const TONES: readonly ProjectTone[] = ["hercule", "ops"];

export const pickProjectTone = (projectId: string, projects: readonly Project[]): ProjectTone => {
  const index = projects.findIndex((each) => each.id === projectId);
  // A project that is not in the list has no neighbours to differ from.
  return index < 0 ? TONES[0]! : TONES[index % TONES.length]!;
};
