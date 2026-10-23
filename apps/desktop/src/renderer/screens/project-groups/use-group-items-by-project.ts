import { useSuspenseQuery } from "@tanstack/react-query";
import { orderProjectIdsByNewestGroup, type HerculeClient } from "@hercule/client-core";
import {
  groupByProject,
  type ProjectGroupEntry,
  type RepositoryRecord,
} from "@hercule/client-core/project-groups";
import type { Project } from "@hercule/contract";
import { projectsQuery, resourcesQuery, threadAndAgentSessionsQuery } from "../../app/queries";

/**
 * Reads the projects, the repositories and the threads that order the
 * projects, and returns `items` grouped by project as the list draws them,
 * with the projects in their own order for the headings' tints. The three
 * reads are shell reads and are cached already, so this suspends only if the
 * cache was dropped.
 */
export const useGroupItemsByProject = <Item extends RepositoryRecord>(
  client: HerculeClient,
  items: readonly Item[],
): {
  readonly entries: readonly ProjectGroupEntry<Item>[];
  readonly projects: readonly Project[];
} => {
  const { data: resources } = useSuspenseQuery(resourcesQuery(client));
  const { data: projects } = useSuspenseQuery(projectsQuery(client));
  const { data: projectOrder } = useSuspenseQuery({
    ...threadAndAgentSessionsQuery(client),
    select: orderProjectIdsByNewestGroup,
  });
  return { entries: groupByProject({ items, resources, projects, projectOrder }), projects };
};
