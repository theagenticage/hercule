import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { controllerQuery, projectsQuery, readOnOpen } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { WorkScreen } from "./-work-screen";
import { workBoardQuery } from "./-work-board";

/**
 * The search params of Work:
 *
 * - `task`: the Task whose details are open. It lives in the address, so a
 *   reload, or coming back from a Thread or a run that the details opened,
 *   finds the same details open.
 *
 * A param may be `undefined` in a search a caller builds, which removes it
 * from the URL.
 */
export interface WorkSearch {
  readonly task?: string | undefined;
  readonly failed?: true | undefined;
}

/**
 * Returns Work's search params from the URL's. A `task` that is not an id is
 * dropped. A dropped param is returned as `undefined` rather than left out,
 * because the router lays the returned params over the URL's: a param left
 * out would keep the URL's value.
 */
const validateWorkSearch = (search: Record<string, unknown>): WorkSearch => ({
  task: isId(search.task) ? search.task : undefined,
  failed: search.failed === true ? true : undefined,
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
 * cache. The controller's record, which says whether summaries can be
 * written, is also read without waiting.
 *
 * The loader reads nothing for the open Task, and a change of `task` does not
 * run it again. The details read themselves when the sheet opens, and the
 * sheet draws quiet bars until they arrive.
 */
export const Route = createFileRoute("/_connected/_shell/work")({
  staticData: { title: "Work" },
  validateSearch: validateWorkSearch,
  loader: ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    if (isWindowVisible()) void queryClient.prefetchQuery(workBoardQuery(client));
    // Whether Text Generation can run decides if a card promises a summary. The read does not
    // block the screen, and a failed one leaves the cards without that promise.
    void readOnOpen(queryClient, controllerQuery(client)).catch(() => undefined);
    return queryClient.ensureQueryData(projectsQuery(client));
  },
  component: WorkRoute,
});

function WorkRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { task, failed } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkScreen
      controller={controller}
      openTaskId={task ?? null}
      isOpeningOnFailed={failed === true}
      onOpenedOnFailed={() => {
        void navigate({ search: { task }, replace: true });
      }}
      onChangeOpenTask={(taskId) => {
        // The address is replaced, never added to: there is no Back to step
        // through the Tasks, and Esc closes the details.
        void navigate({ search: { task: taskId ?? undefined }, replace: true });
      }}
    />
  );
}
