import type { JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useMatch, useNavigate } from "@tanstack/react-router";
import { readActorSessionId, resolveDisplayTimezone } from "@hercule/client-core";
import { useScreenTopicsLive, WIKI_TOPICS } from "../../../../app/live";
import { readOnOpen, readSenders, settingsQuery, wikiPagesQuery } from "../../../../app/queries";
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
import {
  WikiColumnRow,
  WikiTableHeads,
  WikiTableRow,
} from "../../../../screens/wiki/wiki-list-rows";

/**
 * Wiki: the list of wiki pages and the open page (spec 19 section 8.2). It
 * is the layout route of the wiki pages, so the list keeps its place while
 * pages open and close under it (`$pageId.tsx`). The list is one list at three
 * widths:
 *
 * - the table, while no page is open;
 * - a column beside the open page;
 * - hidden, while the open page fills the pane (`full`).
 *
 * Its loader reads everything the list draws before it renders, so nothing on
 * the page waits:
 *
 * - the first page of wiki pages, which the `wikiPage` topic keeps current
 *   while the page is open;
 * - the sessions of the agents that last changed those pages, so their names
 *   are drawn at the first paint;
 * - the settings, for the time zone the times are shown in, read each time
 *   the page opens because no topic covers them.
 *
 * The projects, the repositories and the threads that order the projects are
 * shell reads and are cached already. The list reads the next page of wiki
 * pages only when it is scrolled to its end.
 *
 * Opening a page runs the loader again with `cause` "stay". It then reads
 * nothing that is cached, so clicking a row sends no request.
 */
export const Route = createFileRoute("/_connected/_shell/wiki")({
  staticData: { title: "Wiki" },
  loader: async ({ context: { controller, queryClient }, cause }) => {
    const { client } = controller;
    const [pages] = await Promise.all([
      queryClient.ensureInfiniteQueryData(wikiPagesQuery(client)),
      cause === "stay"
        ? queryClient.ensureQueryData(settingsQuery(client))
        : readOnOpen(queryClient, settingsQuery(client)),
    ]);
    const senderSessionIds = new Set(
      pages.pages[0]?.items.flatMap((page) => readActorSessionId(page.updatedBy) ?? []),
    );
    await readSenders(queryClient, client, [...senderSessionIds]);
  },
  component: WikiLayout,
});

/** The open page's route, whose search holds `full`. */
const OPEN_PAGE_ROUTE = "/_connected/_shell/wiki/$pageId";

/** The text the list shows when the Wiki holds no page. */
const EMPTY_LIST = {
  title: "No wiki pages yet",
  text: "Agents write pages here for the agents that come after them: how a repository works, and what they learned.",
} as const;

/**
 * Keeps the wiki pages' reads current while the page is open, groups the
 * pages by project, and draws the list at the width the route asks for, and
 * the open page beside it.
 *
 * While a page is open, Esc closes it, back to the table, unless something
 * else takes Esc first (`useCloseOnEscape`). After the list is drawn at a new
 * width, focus moves to the page's row (`useRestoreRowFocus`).
 */
function WikiLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useScreenTopicsLive(controller.live, queryClient, WIKI_TOPICS);
  const navigate = useNavigate();
  const openPage = useMatch({ from: OPEN_PAGE_ROUTE, shouldThrow: false });
  const width = computeListPaneWidth(openPage);
  const toggleList = useToggleListPane(openPage, width);
  const initialPageId = useLastOpenItemId(openPage?.params.pageId);

  useRestoreRowFocus(width, initialPageId, findGroupedItemRow);
  useCloseOnEscape(openPage !== undefined, () => void navigate({ to: "/wiki" }));

  const pages = useSuspenseInfiniteQuery(wikiPagesQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { entries, projects } = useGroupItemsByProject(
    client,
    pages.data.pages.flatMap((page) => page.items),
  );
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  return (
    <div className="workflows-page">
      <ListPageHeader title="Wiki" to="/wiki" width={width} onToggleList={toggleList} />
      {width === "full" ? null : (
        <ProjectGroupedList
          width={width}
          label="Wiki page list"
          className="wiki-list"
          entries={entries}
          projects={projects}
          tableHeads={<WikiTableHeads />}
          tableRow="twoLineRow"
          renderRow={(page, place) => {
            const Row = width === "table" ? WikiTableRow : WikiColumnRow;
            return (
              <Row
                key={place.itemKey}
                itemKey={place.itemKey}
                pageId={page.id}
                title={page.title}
                summary={page.summary}
                updatedBy={page.updatedBy}
                updatedAt={page.updatedAt}
                timezone={timezone}
                marginTop={place.marginTop}
                onScreen={place.onScreen}
              />
            );
          }}
          empty={EMPTY_LIST}
          nextPage={pages}
          initialItemId={initialPageId}
        />
      )}
      <Outlet />
    </div>
  );
}
