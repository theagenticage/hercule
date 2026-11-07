import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { projectsQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { WorkScreen } from "./-work-screen";
import { workBoardQuery } from "./-work-board";

/**
 * The search params of Work: `task` names a Task whose card the board brings
 * into view and puts the keyboard on, as when the Inbox's See its Task goes
 * here.
 */
export interface WorkSearch {
  readonly task?: string | undefined;
}

/**
 * Returns Work's search params from the URL's. A `task` that is not an id is
 * dropped, so the screen never acts on a malformed link. A dropped param is
 * returned as `undefined` rather than left out, because the router lays the
 * returned params over the URL's.
 */
const validateWorkSearch = (search: Record<string, unknown>): WorkSearch => ({
  task: isId(search.task) ? search.task : undefined,
});

/**
 * Work: every unfinished Task as a card, placed by stage in a lane per
 * Project (spec 17 §Work). One of the two views of the Overview, beside the
 * Office.
 *
 * The route is a chunk of its own. Its loader starts the board's read without
 * waiting for it, so the screen shows its loading state, with the stage names
 * and lanes already in place, instead of holding the whole app on the
 * previous screen. A hidden window starts no read: the board is read when the
 * window shows (see `useWorkBoard`). The Projects name the lanes. The shell
 * has read them already and keeps them current, so this read is from the
 * cache.
 */
export const Route = createFileRoute("/_connected/_shell/work")({
  staticData: { title: "Work" },
  validateSearch: validateWorkSearch,
  loader: ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    if (isWindowVisible()) void queryClient.prefetchQuery(workBoardQuery(client));
    return queryClient.ensureQueryData(projectsQuery(client));
  },
  component: WorkRoute,
});

function WorkRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { task } = Route.useSearch();
  return <WorkScreen controller={controller} taskToShow={task} />;
}
