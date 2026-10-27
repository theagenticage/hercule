import type { JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useMatch, useNavigate } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { DISCUSSION_TOPICS, useScreenTopicsLive } from "../../../../app/live";
import { discussionsQuery, readOnOpen, settingsQuery } from "../../../../app/queries";
import {
  DiscussionColumnRow,
  DiscussionTableHeads,
  DiscussionTableRow,
} from "../../../../screens/discussions/discussion-list-rows";
import { ListPageHeader } from "../../../../screens/list-pane/list-page-header";
import {
  computeListPaneWidth,
  useCloseOnEscape,
  useLastOpenItemId,
  useRestoreRowFocus,
  useToggleListPane,
} from "../../../../screens/list-pane/list-with-open-pane";
import {
  findGroupedItemRow,
  ProjectGroupedList,
} from "../../../../screens/project-groups/project-grouped-list";
import { useGroupItemsByProject } from "../../../../screens/project-groups/use-group-items-by-project";

/**
 * Discussions: the list of Discussions and the open Discussion (spec 19
 * section 8.2). It is the layout route of the Discussion pages, so the list
 * keeps its place while Discussions open and close under it
 * (`$discussionId.tsx`). The list is one list at three widths:
 *
 * - the table, while no Discussion is open;
 * - a column beside the open Discussion;
 * - hidden, while the open Discussion fills the pane (`full`).
 *
 * Its loader reads everything the list draws before it renders, so nothing on
 * the page waits:
 *
 * - the first page of Discussions, which the `discussion` topic keeps current
 *   while the page is open;
 * - the settings, for the time zone the times are shown in, read each time
 *   the page opens because no topic covers them.
 *
 * The projects, the repositories and the threads that order the projects are
 * shell reads and are cached already. The list reads the next page of
 * Discussions only when it is scrolled to its end.
 *
 * Opening a Discussion runs the loader again with `cause` "stay". It then
 * reads nothing that is cached, so clicking a row sends no request.
 */
export const Route = createFileRoute("/_connected/_shell/discussions")({
  staticData: { title: "Discussions" },
  loader: async ({ context: { controller, queryClient }, cause }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureInfiniteQueryData(discussionsQuery(client)),
      cause === "stay"
        ? queryClient.ensureQueryData(settingsQuery(client))
        : readOnOpen(queryClient, settingsQuery(client)),
    ]);
  },
  component: DiscussionsLayout,
});

/** The open Discussion's route, whose search holds `full`. */
const OPEN_DISCUSSION_ROUTE = "/_connected/_shell/discussions/$discussionId";

/** The text the list shows when there is no Discussion. */
const EMPTY_LIST = {
  title: "No discussions yet",
  text: "Agents open one when their edits overlap, or when they want to ask each other something.",
} as const;

/**
 * Keeps the Discussions' reads current while the page is open, groups the
 * Discussions by project, and draws the list at the width the route asks
 * for, and the open Discussion beside it.
 *
 * While a Discussion is open, Esc closes it, back to the table, unless
 * something else takes Esc first (`useCloseOnEscape`). After the list is
 * drawn at a new width, focus moves to the Discussion's row
 * (`useRestoreRowFocus`).
 */
function DiscussionsLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useScreenTopicsLive(controller.live, queryClient, DISCUSSION_TOPICS);
  const navigate = useNavigate();
  const openDiscussion = useMatch({ from: OPEN_DISCUSSION_ROUTE, shouldThrow: false });
  const width = computeListPaneWidth(openDiscussion);
  const toggleList = useToggleListPane(openDiscussion, width);
  const initialDiscussionId = useLastOpenItemId(openDiscussion?.params.discussionId);

  useRestoreRowFocus(width, initialDiscussionId, findGroupedItemRow);
  useCloseOnEscape(openDiscussion !== undefined, () => void navigate({ to: "/discussions" }));

  const discussions = useSuspenseInfiniteQuery(discussionsQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { entries, projects } = useGroupItemsByProject(
    client,
    discussions.data.pages.flatMap((page) => page.items),
  );
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  return (
    <div className="workflows-page">
      <ListPageHeader
        title="Discussions"
        to="/discussions"
        width={width}
        onToggleList={toggleList}
      />
      {width === "full" ? null : (
        <ProjectGroupedList
          width={width}
          label="Discussion list"
          className="discussion-list"
          entries={entries}
          projects={projects}
          tableHeads={<DiscussionTableHeads />}
          tableRow="oneLineRow"
          renderRow={(discussion, place) => {
            const Row = width === "table" ? DiscussionTableRow : DiscussionColumnRow;
            return (
              <Row
                key={place.itemKey}
                itemKey={place.itemKey}
                discussionId={discussion.id}
                kind={discussion.kind}
                subject={discussion.subject}
                participantCount={discussion.participantCount}
                postCount={discussion.postCount}
                lastPostAt={discussion.lastPostAt}
                timezone={timezone}
                marginTop={place.marginTop}
                onScreen={place.onScreen}
              />
            );
          }}
          empty={EMPTY_LIST}
          nextPage={discussions}
          initialItemId={initialDiscussionId}
        />
      )}
      <Outlet />
    </div>
  );
}
