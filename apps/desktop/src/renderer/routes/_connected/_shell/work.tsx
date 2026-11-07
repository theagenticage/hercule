import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { projectsQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { WorkScreen } from "./-work-screen";
import { workBoardQuery } from "./-work-board";

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
  loader: ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    if (isWindowVisible()) void queryClient.prefetchQuery(workBoardQuery(client));
    return queryClient.ensureQueryData(projectsQuery(client));
  },
  component: WorkRoute,
});

function WorkRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  return <WorkScreen controller={controller} />;
}
