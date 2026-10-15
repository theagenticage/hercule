/**
 * Groups the Discussion and Wiki Page lists by project, the way the sidebar
 * groups threads (spec 19 section 8.2). Both screens read their records a
 * page at a time and call `groupByProject` on the pages read so far.
 *
 * It is a subpath export of its own and not part of the package's index,
 * because only the two screens that load lazily use it, and the first screen
 * must not carry it.
 */
import type { Project, Resource } from "@hercule/contract";
import { formatRepositoryPath } from "./remote";
import { listProjectRepos } from "./threads/workspaces";

/** A record that belongs to one repository: a Discussion or a Wiki Page, as their listings return them. */
export interface RepositoryRecord {
  readonly id: string;
  readonly resourceId: string;
  /** The repository's canonical remote, copied when the record was created. */
  readonly repository: string;
}

/**
 * One entry of a list grouped by project, top to bottom. Its `key` is unique
 * in the list and stays the same for the same thing when more pages are
 * appended.
 */
export type ProjectGroupEntry<Item extends RepositoryRecord> =
  /** A listed project's heading. */
  | {
      readonly kind: "project";
      readonly key: string;
      readonly projectId: string;
      readonly name: string;
    }
  /** The heading of the group "No project": its `projectId` and `name` are `null`, and the screen supplies the words. */
  | {
      readonly kind: "project";
      readonly key: string;
      readonly projectId: null;
      readonly name: null;
    }
  /** A repository's sub-heading, `owner/repo`, over its items. */
  | { readonly kind: "repository"; readonly key: string; readonly name: string }
  | { readonly kind: "item"; readonly key: string; readonly item: Item };

/** The id the keys of the group "No project" are written with. */
const NO_PROJECT_KEY = "none";

/**
 * Returns the projects that `item`'s repository is in, among the projects
 * `listed` holds. Returns an empty array when the repository is not in
 * `resourcesById`, as after it was deleted, or is in no listed project.
 */
const listItemProjectIds = (
  item: RepositoryRecord,
  resourcesById: ReadonlyMap<string, Resource>,
  listed: ReadonlySet<string>,
): readonly string[] =>
  (resourcesById.get(item.resourceId)?.projectIds ?? []).filter((id) => listed.has(id));

/**
 * Returns the entries of `items` grouped by project, top to bottom, as the
 * screens draw them:
 *
 * - An item belongs to every listed project its repository is in, so a
 *   repository in two projects shows under each, and the same item appears
 *   in both groups.
 * - An item whose repository is missing from `resources`, or is in no listed
 *   project, goes to the last group, "No project" (`projectId` is `null`).
 * - Groups are ordered as `projectOrder` lists projects, then the other
 *   listed projects by project id, then "No project". A group with no items
 *   is not returned.
 * - A project with more than one repository gets a `repository` sub-heading
 *   before each repository's items. The count is of all the project's
 *   repositories, not only those with items, so a heading does not appear or
 *   vanish while pages load. A project with one repository has none, and
 *   "No project" always has them.
 * - A sub-heading is named from the `repository` of the repository's first
 *   item, so it survives the repository's deletion.
 * - Inside a group, repositories are in the order their first item appears
 *   in `items`, and items keep the order of `items`.
 *
 * `items` are newest first, as the listing's pages return them. `projectOrder`
 * is `orderProjectIdsByNewestThread`'s result. Entries are keyed by their
 * group and their own id, so appending an older page keeps the keys and the
 * order of what was already listed.
 */
export const groupByProject = <Item extends RepositoryRecord>({
  items,
  resources,
  projects,
  projectOrder,
}: {
  readonly items: readonly Item[];
  readonly resources: readonly Resource[];
  readonly projects: readonly Project[];
  readonly projectOrder: readonly string[];
}): readonly ProjectGroupEntry<Item>[] => {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const listed = new Set(projectsById.keys());

  const itemsByProject = new Map<string | null, Item[]>();
  for (const item of items) {
    const projectIds = listItemProjectIds(item, resourcesById, listed);
    for (const projectId of projectIds.length === 0 ? [null] : projectIds) {
      const held = itemsByProject.get(projectId);
      if (held === undefined) itemsByProject.set(projectId, [item]);
      else held.push(item);
    }
  }

  const ordered = new Set(projectOrder.filter((id) => listed.has(id)));
  const unordered = [...listed].filter((id) => !ordered.has(id)).toSorted();
  const listedInOrder = [...ordered, ...unordered].flatMap((id) => projectsById.get(id) ?? []);
  const groupProjects: readonly (Project | null)[] = [...listedInOrder, null];

  return groupProjects.flatMap((project): ProjectGroupEntry<Item>[] => {
    const projectId = project?.id ?? null;
    const held = itemsByProject.get(projectId);
    if (held === undefined) return [];
    const groupKey = projectId ?? NO_PROJECT_KEY;
    const entries: ProjectGroupEntry<Item>[] = [
      project === null
        ? { kind: "project", key: `project:${groupKey}`, projectId: null, name: null }
        : {
            kind: "project",
            key: `project:${groupKey}`,
            projectId: project.id,
            name: project.name,
          },
    ];
    const itemsByRepository = new Map<string, Item[]>();
    for (const item of held) {
      const repositoryItems = itemsByRepository.get(item.resourceId);
      if (repositoryItems === undefined) itemsByRepository.set(item.resourceId, [item]);
      else repositoryItems.push(item);
    }
    const namesRepositories =
      projectId === null || listProjectRepos(resources, projectId).length > 1;
    for (const [resourceId, repositoryItems] of itemsByRepository) {
      if (namesRepositories) {
        entries.push({
          kind: "repository",
          key: `repository:${groupKey}:${resourceId}`,
          name: formatRepositoryPath(repositoryItems[0]!.repository),
        });
      }
      for (const item of repositoryItems) {
        entries.push({ kind: "item", key: `item:${groupKey}:${item.id}`, item });
      }
    }
    return entries;
  });
};
