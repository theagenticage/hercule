import { useCallback, useState, type JSX, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatch, useRouteContext } from "@tanstack/react-router";
import { useDraftThread } from "../app/draft-thread";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  threadsQuery,
  userQuery,
  workspacesQuery,
} from "../app/queries";
import { useRelatedReads } from "../app/related-reads";
import { useSendOnChange } from "../app/send-on-change";
import { ComposeIcon } from "../icons/compose";
import { OfficeIcon } from "../icons/office";
import { SearchIcon } from "../icons/search";
import { SidebarIcon } from "../icons/sidebar";
import { buildSidebar, listGoMenuThreads, type SectionKey } from "./sidebar-items";
import { SidebarFoot } from "./sidebar-foot";
import { SidebarList } from "./sidebar-list";
import "./sidebar.css";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the sidebar, as the Bureau book's crew.js draws it:
 *
 * - the top strip, where macOS draws the window's traffic lights, with the
 *   Hide the sidebar button;
 * - one row of actions: New thread, which calls `onNewThread`, then Search
 *   and the Office as square icon buttons, where the book draws New thread
 *   and Search as two rows and has no Office button;
 * - the thread list: Waiting on you, then the threads grouped by project and
 *   workspace, with the Draft Thread's row, while one is open, in the group
 *   it will join;
 * - the foot: the thread counts, the signed-in user and the Settings button.
 *
 * Hide the sidebar and Search are drawn but do nothing yet, and carry
 * `aria-disabled` to say so. The open thread is marked in the list by its
 * links, which the router marks as the current page. The Office button is
 * marked the same way while the Office is open, and the Settings button
 * while Settings is open.
 *
 * While the Office is open, the row of a thread with a colleague in the
 * Office opens the thread in the Office's drawer instead of on its own
 * screen, so the user stays in the Office. An asleep or away thread has no
 * colleague, so its row still opens its own screen.
 *
 * The lists it reads are in the cache before the shell renders, because the
 * shell's loader reads them, so nothing here waits in practice. A live push
 * updates the cache, and only the rows whose thread changed draw again.
 *
 * It also sends main the threads it shows, top to bottom, for the Go menu,
 * each time they or their titles change.
 */
export function Sidebar({
  onNewThread,
  assistants,
}: {
  readonly onNewThread: () => void;
  /** PROTOTYPE (#448): the Assistants section, drawn after the threads. */
  readonly assistants?: ReactNode;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  useRelatedReads(threads, projects, workspaces);
  // The Draft Thread the new-thread screen shows, while that screen is open.
  // Its row reads the draft as the screen does, see `useDraftThread`.
  const draftSearch = useMatch({ from: "/_connected/_shell/", shouldThrow: false })?.search;
  const draft = useDraftThread(
    draftSearch === undefined
      ? null
      : { projectId: draftSearch.project ?? null, workspaceId: draftSearch.workspace ?? null },
  );

  // The open thread: the one on its own screen, or the one in the Office's
  // drawer while the Office is open.
  const threadMatch = useMatch({
    from: "/_connected/_shell/threads/$sessionId",
    shouldThrow: false,
  });
  const officeMatch = useMatch({ from: "/_connected/_shell/office", shouldThrow: false });
  const officeOpen = officeMatch !== undefined;
  const selectedId = threadMatch?.params.sessionId ?? officeMatch?.search.session ?? null;

  // The sections whose "more" row the user pressed. Kept only while the
  // window is open: a restart shows every section capped again.
  const [expanded, setExpanded] = useState<ReadonlySet<SectionKey>>(() => new Set());
  // Passed to every "more" row, which is memoized, so it keeps one identity.
  const expandSection = useCallback((section: SectionKey) => {
    setExpanded((current) => new Set(current).add(section));
  }, []);

  const { items, counts } = buildSidebar({
    threads,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    draft,
    expanded,
    selectedId,
  });
  useSendOnChange(listGoMenuThreads(items), bridge.goMenu.set, "Could not update the Go menu:");

  return (
    <aside className="side">
      <div className="side-top">
        <button type="button" className="icon-btn" title="Hide the sidebar" aria-disabled="true">
          <SidebarIcon />
        </button>
      </div>
      {/* The space between a row's text and its key cap keeps the row's name
          "New thread ⌘N", not "New thread⌘N". A row is a flex box, which
          draws no space between its items, so the layout is the book's. The
          two icon buttons name their shortcut in their tooltip, as the
          other icon buttons of the sidebar name themselves. */}
      <div className="side-actions">
        <button type="button" className="nav-row" onClick={onNewThread}>
          <ComposeIcon />
          <span>New thread</span> <kbd>⌘N</kbd>
        </button>
        <button type="button" className="icon-btn" title="Search ⌘K" aria-disabled="true">
          <SearchIcon />
        </button>
        <Link
          to="/office"
          className="icon-btn"
          title="Office ⌘⇧O"
          activeProps={SELECTED_LINK_PROPS}
        >
          <OfficeIcon />
        </Link>
      </div>
      <SidebarList
        items={items}
        officeOpen={officeOpen}
        onExpand={expandSection}
        after={assistants}
      />
      <SidebarFoot
        working={counts.working}
        waiting={counts.waiting}
        idle={counts.idle}
        username={username}
      />
    </aside>
  );
}
