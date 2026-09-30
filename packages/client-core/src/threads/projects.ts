/**
 * Builds the rows of the project picker. A new thread starts by picking its
 * project, because the project bounds everything the composer offers below
 * it: its repos and its workspaces. Each row shows how many repos, threads and
 * workspaces the project has, so the user can choose by what is in a project
 * rather than by its name alone. Spec 14 §The composer owns the picker.
 */
import type { Project, Resource, Session, Workspace } from "@hercule/contract";
import { pickProjectTone, type ProjectTone } from "./tone";
import { listProjectRepos, listProjectWorkspaces, formatRepoName } from "./workspaces";

export interface ProjectPickerRow {
  readonly projectId: string;
  readonly name: string;
  readonly tone: ProjectTone;
  /** `1 repo · webshop · 5 threads · 2 workspaces`. */
  readonly sub: string;
  /** `⌘1`, or `null` after the ninth row, because there are no more number keys. */
  readonly shortcut: string | null;
}

const formatCount = (n: number, word: string): string =>
  `${String(n)} ${n === 1 ? word : `${word}s`}`;

export const buildProjectPickerRows = ({
  projects,
  resources,
  workspaces,
  sessions,
}: {
  readonly projects: readonly Project[];
  readonly resources: readonly Resource[];
  readonly workspaces: readonly Workspace[];
  readonly sessions: readonly Session[];
}): readonly ProjectPickerRow[] =>
  projects.map((project, index) => {
    const repos = listProjectRepos(resources, project.id);
    const threads = sessions.filter((session) => session.projectId === project.id).length;
    const live = listProjectWorkspaces(workspaces, repos).length;
    return {
      projectId: project.id,
      name: project.name,
      tone: pickProjectTone(project.id, projects),
      sub: [
        formatCount(repos.length, "repo"),
        ...(repos.length === 0 ? [] : [repos.map(formatRepoName).join(", ")]),
        formatCount(threads, "thread"),
        formatCount(live, "workspace"),
      ].join(" · "),
      shortcut: index < 9 ? `⌘${String(index + 1)}` : null,
    };
  });
