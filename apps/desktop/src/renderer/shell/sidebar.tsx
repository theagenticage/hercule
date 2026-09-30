import { useCallback, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMatch, useRouteContext } from "@tanstack/react-router";
import {
  buildSidebarSections,
  buildThreadGroups,
  countThreadsByPose,
  decideThreadPose,
} from "@hercule/client-core";
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
import { ComposeIcon, SearchIcon, SidebarIcon } from "../icons";
import { useOpenDraft } from "./open-draft";
import { buildExpandedSections, buildSidebarItems, type SectionKey } from "./sidebar-items";
import { SidebarFoot } from "./sidebar-foot";
import { SidebarList } from "./sidebar-list";
import "./sidebar.css";

/**
 * Renders the sidebar, as the Bureau book's crew.js draws it:
 *
 * - the top strip, where macOS draws the window's traffic lights, with the
 *   Hide the sidebar button;
 * - New thread, which calls `onNewThread`, and Search;
 * - the thread list: Waiting on you, then the threads grouped by project and
 *   workspace, with the Draft Thread's row, while one is open, in the group
 *   it will join;
 * - the foot: the thread counts and the signed-in user.
 *
 * Hide the sidebar, Search and Settings are drawn but do nothing yet, and
 * carry `aria-disabled` to say so. The open thread is marked in the list by
 * its links, which the router marks as the current page.
 *
 * The lists it reads are in the cache before the shell renders, because the
 * shell's loader reads them, so nothing here waits in practice. A live push
 * updates the cache, and only the rows whose thread changed draw again.
 */
export function Sidebar({ onNewThread }: { readonly onNewThread: () => void }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  useRelatedReads(threads, projects, workspaces);
  const draft = useOpenDraft();

  const selectedId =
    useMatch({ from: "/_connected/_shell/threads/$sessionId", shouldThrow: false })?.params
      .sessionId ?? null;

  // The sections whose "more" row the user pressed. Kept only while the
  // window is open: a restart shows every section capped again.
  const [expanded, setExpanded] = useState<ReadonlySet<SectionKey>>(() => new Set());
  // Passed to every "more" row, which is memoized, so it keeps one identity.
  const expandSection = useCallback((section: SectionKey) => {
    setExpanded((current) => new Set(current).add(section));
  }, []);

  const sessions = new Map(threads.map((session) => [session.id, session]));
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const poses = new Map(
    threads.map((session) => [
      session.id,
      decideThreadPose(
        session,
        session.runnerId === null ? undefined : runnersById.get(session.runnerId),
      ),
    ]),
  );
  const groups = buildThreadGroups({
    sessions: threads,
    projects,
    workspaces,
    resources,
    runners,
    instances,
    mode: "meta",
    draft: draft?.place ?? null,
  });
  const sections = buildSidebarSections({
    groups,
    poses,
    expanded: buildExpandedSections(expanded, groups),
    selectedId,
  });
  const items = buildSidebarItems({
    sections,
    sessions,
    runners: runnersById,
    projects,
    draftMeta: draft?.rowMeta ?? null,
  });
  const counts = countThreadsByPose(poses.values());

  return (
    <aside className="side">
      <div className="side-top">
        <button type="button" className="icon-btn" title="Hide the sidebar" aria-disabled="true">
          <SidebarIcon />
        </button>
      </div>
      {/* The space between a row's text and its key cap keeps the row's name
          "New thread ⌘N", not "New thread⌘N". A row is a flex box, which
          draws no space between its items, so the layout is the book's. */}
      <div className="side-actions">
        <button type="button" className="nav-row" onClick={onNewThread}>
          <ComposeIcon />
          <span>New thread</span> <kbd>⌘N</kbd>
        </button>
        <button type="button" className="nav-row" aria-disabled="true">
          <SearchIcon />
          <span>Search</span> <kbd>⌘K</kbd>
        </button>
      </div>
      <SidebarList items={items} onExpand={expandSection} />
      <SidebarFoot
        working={counts.working}
        waiting={counts.waiting}
        idle={counts.idle}
        username={username}
      />
    </aside>
  );
}
