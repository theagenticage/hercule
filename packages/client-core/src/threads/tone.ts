/**
 * The identity hue a project wears, read in one place so every surface that
 * shows a project - the picker, the sidebar's headers, a draft's heading -
 * gives the same project the same hue.
 */
import type { Project } from "@hercule/contract";

/**
 * Which identity hue a project's dot carries. The design language fixes two
 * (§Color doctrine), so they alternate: a hue tells two neighbouring projects
 * apart, it does not name one.
 *
 * Which is why the hue follows the project's place in the listing rather than
 * anything about the project itself: hashing the id gave two projects the same
 * hue as often as not, and two headers standing next to each other in one
 * colour is the one thing the dot exists to prevent (R6). The listing is the
 * one `project.query` answers with, which every surface here reads, so the
 * same project wears the same hue on all of them.
 */
export type ProjectTone = "hercule" | "ops";

const TONES: readonly ProjectTone[] = ["hercule", "ops"];

export const projectTone = (projectId: string, projects: readonly Project[]): ProjectTone => {
  const index = projects.findIndex((each) => each.id === projectId);
  // A project the listing does not hold has no neighbours to differ from.
  return index < 0 ? TONES[0]! : TONES[index % TONES.length]!;
};
