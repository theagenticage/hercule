/**
 * The project picker (spec 14 §The composer): "the project comes first because
 * it bounds everything below it". One row per project, saying how much stands
 * under it, so the choice is made on what is there rather than on a name.
 */
import type { Project, Resource, Session, Workspace } from "@hydra/contract";
import { projectTone, type ProjectTone } from "./tone";
import { projectRepos, projectWorkspaces, repoName } from "./workspaces";

export interface ProjectPickerRow {
  readonly projectId: string;
  readonly name: string;
  readonly tone: ProjectTone;
  /** `1 repo · webshop · 5 threads · 2 workspaces`. */
  readonly sub: string;
  /** `⌘1`; null past the ninth row, which has no key left to offer. */
  readonly shortcut: string | null;
}

const count = (n: number, word: string): string => `${String(n)} ${n === 1 ? word : `${word}s`}`;

export const projectPickerRows = ({
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
    const repos = projectRepos(resources, project.id);
    const threads = sessions.filter((session) => session.projectId === project.id).length;
    const live = projectWorkspaces(workspaces, repos).length;
    return {
      projectId: project.id,
      name: project.name,
      tone: projectTone(project.id, projects),
      sub: [
        count(repos.length, "repo"),
        ...(repos.length === 0 ? [] : [repos.map(repoName).join(", ")]),
        count(threads, "thread"),
        count(live, "workspace"),
      ].join(" · "),
      shortcut: index < 9 ? `⌘${String(index + 1)}` : null,
    };
  });
