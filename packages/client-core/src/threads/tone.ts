/**
 * Picks the identity hue for a project. It is decided in one place so every
 * screen that shows a project (the picker, the sidebar headers, a draft's
 * heading) gives the same project the same hue.
 *
 * The hue follows the project's position in the project list that
 * `project.query` returns, sorted by name, counted round the palette:
 *
 * - Two projects next to each other in the project list never share a hue.
 * - A screen that orders projects differently can put two projects with the
 *   same hue next to each other. The sidebar sorts projects by their latest
 *   thread, so two neighbouring headers there can share a hue.
 *
 * The hue follows the project list, not the order of the screen it is drawn
 * on, because a project must keep its hue on every screen and over time. A
 * hue that followed the sidebar's order would change every time another
 * project became the most recently active. The project list's order changes
 * only when a project is added, deleted or renamed. Hashing the id would keep
 * the hue stable too, but gave two projects the same hue about half the time.
 *
 * The rule is shared and the palette is each app's: the web app has two
 * tones, the desktop app's Bureau design has three tints.
 */
import type { Project } from "@hercule/contract";

/**
 * Returns the palette entry for a project: the project's position in
 * `projects`, counted round the palette. Two projects next to each other in
 * `projects` never share an entry; projects shown in another order can. A
 * project that is not in `projects` returns the first entry.
 */
export const pickProjectHue = <Hue>(
  projectId: string,
  projects: readonly Project[],
  palette: readonly [Hue, ...Hue[]],
): Hue => {
  const index = projects.findIndex((each) => each.id === projectId);
  return index < 0 ? palette[0] : palette[index % palette.length]!;
};

/** The identity hue of a project's dot in the web app. The design language defines two (§Color doctrine). */
export type ProjectTone = "hercule" | "ops";

const TONES: readonly [ProjectTone, ...ProjectTone[]] = ["hercule", "ops"];

/** Returns the web app's hue for a project's dot, which alternates down the project list. */
export const pickProjectTone = (projectId: string, projects: readonly Project[]): ProjectTone =>
  pickProjectHue(projectId, projects, TONES);
