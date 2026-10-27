import { memo, useCallback, useEffect, useId, useMemo, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DONE_SHELF_LIMIT, DONE_SHELF_STEP } from "@hercule/client-core";
import { Link, useLocation, useMatch, useRouteContext } from "@tanstack/react-router";
import { useAssistantRows } from "../app/assistant-rows";
import { useDoneMoves } from "../app/done-moves";
import { useDraftThread } from "../app/draft-thread";
import { useUnsentKeys } from "../app/pending-submissions";
import { projectsQuery, userQuery } from "../app/queries";
import { useSendOnChange } from "../app/send-on-change";
import { useOpenSessionId, useSessionPresentation } from "../app/session-presentation";
import { useWaiting, useWaitingRunSessions } from "../app/waiting";
import { ComposeIcon } from "../icons/compose";
import { OfficeIcon } from "../icons/office";
import { SearchIcon } from "../icons/search";
import { SidebarIcon } from "../icons/sidebar";
import { AssistantsSection } from "./assistants-section";
import { DoneToastHost } from "./done-toast";
import { FaceSwitch } from "./face-switch";
import { decideScreenFace, type SidebarFace } from "./sidebar-face";
import { buildSidebar, listGoMenuItems, type SectionKey } from "./sidebar-items";
import { SidebarFoot } from "./sidebar-foot";
import { SidebarList } from "./sidebar-list";
import { SystemSection } from "./system-section";
import { toggleSidebar } from "./use-sidebar-layout";
import { WorkSection } from "./work-section";
import "./sidebar.css";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the sidebar, as the Bureau book's crew.js draws it:
 *
 * - the top strip, where macOS draws the window's traffic lights, with the
 *   Hide the sidebar button;
 * - the face switch, Threads | Hercule;
 * - one row of actions: New thread, which calls `onNewThread`, then Search
 *   and the Office as square icon buttons, where the book draws New thread
 *   and Search as two rows and has no Office button;
 * - the list: Waiting on you, with the threads and the assistants that wait
 *   on the user, then the face's own rows.
 *   - On the threads face, the groups of each project, the most recently
 *     started (created or reopened) first, with the Draft Thread's row, while
 *     one is open, first in its project. A group is the Threads and Agent
 *     sessions that work in one workspace. A group of several unfolds into a
 *     line for each session, by its dots or the arrow keys. A row whose
 *     composer holds unsent work is tinted. A row's Done button marks the
 *     group's Threads Done: the group leaves its project at once, and the
 *     toast over the list's bottom edge says "Marked done" with Undo. Then
 *     the Done shelf, closed until its heading is pressed, whose rows of
 *     several sessions unfold into their lines too. Then the Assistants
 *     section, pinned under the list, while there is an assistant.
 *   - On the Hercule face, the System section;
 * - the foot: how many sessions are working, waiting and idle, the
 *   signed-in user and the Settings button.
 *
 * The face follows the screen (`decideScreenFace`). The switch, and View ›
 * Threads and View › Hercule in the menu, change it without leaving the
 * screen.
 *
 * Search is drawn but does nothing yet, and carries `aria-disabled` to say
 * so. The open thread is marked in the list by its
 * links, which the router marks as the current page. The Office button is
 * marked the same way while the Office is open, and the Settings button
 * while Settings is open.
 *
 * A group's row opens the session last open in the group, else its lead.
 * Which groups are unfolded, and which session was last open in each, are
 * kept in memory only.
 *
 * While the Office is open, the row of a session with a colleague in the
 * Office opens the session in the Office's drawer instead of on its own
 * screen, so the user stays in the Office (`isSessionSeated` decides). Every
 * thread not marked Done has a colleague, asleep and away ones too; an Agent's
 * session has one while it works, waits or is idle; a Done thread has none
 * unless it waits, so its row still opens its own screen. A row, a line and a
 * shelf row each ask about the session they open. A run's waiting session,
 * under "From runs", opens in the drawer too.
 *
 * The lists it reads are in the cache before the shell renders, because the
 * shell's loader reads them, so nothing here waits in practice. A live push
 * updates the cache, and only the rows whose thread changed draw again.
 *
 * It also sends main the threads and the waiting assistants the threads face
 * shows, top to bottom, for the Go menu, each time they or their titles
 * change, whichever face is showing. The runs' waiting sessions are not sent:
 * the Go menu does not list them.
 */
export const Sidebar = memo(function Sidebar({
  onNewThread,
}: {
  readonly onNewThread: () => void;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const presentation = useSessionPresentation();
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const assistantRows = useAssistantRows();
  const waiting = useWaiting();
  const waitingRunSessions = useWaitingRunSessions();
  const unsentKeys = useUnsentKeys(controller.pendingSubmissions);
  // The Draft Thread the new-thread screen shows, while that screen is open.
  // Its row reads the draft as the screen does, see `useDraftThread`.
  const draftSearch = useMatch({ from: "/_connected/_shell/", shouldThrow: false })?.search;
  const draft = useDraftThread(
    draftSearch === undefined
      ? null
      : { projectId: draftSearch.project ?? null, workspaceId: draftSearch.workspace ?? null },
  );

  // The open session: the one on its own screen, or the one in the Office's
  // drawer while the Office is open.
  const selectedId = useOpenSessionId();
  const officeOpen =
    useMatch({ from: "/_connected/_shell/office", shouldThrow: false }) !== undefined;
  const listId = useId();

  // The face is set again each time a screen with a face of its own opens,
  // while rendering, so the sidebar never draws the old face beside the new
  // screen. The whole address is compared, not only the path, because a new
  // Draft Thread opens at "/" with other search parameters.
  const { pathname, href } = useLocation();
  const [face, setFace] = useState<SidebarFace>(() => decideScreenFace(pathname) ?? "threads");
  const [faceHref, setFaceHref] = useState(href);
  if (faceHref !== href) {
    setFaceHref(href);
    const screenFace = decideScreenFace(pathname);
    if (screenFace !== null) setFace(screenFace);
  }
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "showThreadsFace") setFace("threads");
        if (command === "showOrchestrationFace") setFace("orchestration");
      }),
    [bridge],
  );

  // The sections whose "more" row the user pressed. Kept only while the
  // window is open: a restart shows every section capped again.
  const [expanded, setExpanded] = useState<ReadonlySet<SectionKey>>(() => new Set());
  // Passed to every "more" row, which is memoized, so it keeps one identity.
  // The Done shelf's length, or `null` while it is closed. Like the
  // sections, it is kept only while the window is open.
  const [doneShelfLimit, setDoneShelfLimit] = useState<number | null>(null);
  // The groups the user unfolded, the groups whose quiet sessions the user
  // showed, and the session last open in each group. Kept only while the
  // window is open. Opening a session never unfolds its group.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [quietShown, setQuietShown] = useState<ReadonlySet<string>>(() => new Set());
  const [lastOpen, setLastOpen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const toggleGroup = useCallback((groupKey: string, unfold: boolean) => {
    setUnfolded((current) => {
      if (current.has(groupKey) === unfold) return current;
      const next = new Set(current);
      if (unfold) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }, []);
  const showQuiet = useCallback((groupKey: string) => {
    setQuietShown((current) => (current.has(groupKey) ? current : new Set(current).add(groupKey)));
  }, []);
  const expandSection = useCallback((section: SectionKey) => {
    if (section === "done") {
      setDoneShelfLimit((limit) => (limit ?? DONE_SHELF_LIMIT) + DONE_SHELF_STEP);
      return;
    }
    setExpanded((current) => new Set(current).add(section));
  }, []);
  const collapseSection = useCallback((section: SectionKey) => {
    setExpanded((current) => {
      if (!current.has(section)) return current;
      const next = new Set(current);
      next.delete(section);
      return next;
    });
  }, []);
  const toggleDoneShelf = useCallback(() => {
    setDoneShelfLimit((limit) => (limit === null ? DONE_SHELF_LIMIT : null));
  }, []);
  // The toast reads its store on its own, so showing, fading or dismissing a
  // toast does not draw the sidebar again.
  const { markDone, reopen } = useDoneMoves();
  const listActions = useMemo(
    () => ({
      onExpand: expandSection,
      onCollapse: collapseSection,
      onMarkDone: markDone,
      onReopen: reopen,
      onToggleDoneShelf: toggleDoneShelf,
      onToggleGroup: toggleGroup,
      onShowQuiet: showQuiet,
    }),
    [expandSection, collapseSection, markDone, reopen, toggleDoneShelf, toggleGroup, showQuiet],
  );

  const { items, openGroupKey } = buildSidebar({
    presentation,
    waiting,
    waitingRunSessions,
    projects,
    draft,
    unsentKeys,
    expanded,
    doneShelfLimit,
    selectedId,
    unfolded,
    quietShown,
    lastOpen,
  });
  // The row of a group opens the session last open in it, however that was
  // opened. The row already opens the open session while the group holds it,
  // so this only remembers it for after the user opens something else.
  useEffect(() => {
    if (selectedId === null || openGroupKey === null) return;
    setLastOpen((current) =>
      current.get(openGroupKey) === selectedId
        ? current
        : new Map(current).set(openGroupKey, selectedId),
    );
  }, [selectedId, openGroupKey]);
  useSendOnChange(listGoMenuItems(items), bridge.goMenu.set, "Could not update the Go menu:");

  return (
    <aside className="side">
      <div className="side-top">
        <button
          type="button"
          className="icon-btn"
          title="Hide the sidebar ⌘B"
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </button>
      </div>
      <FaceSwitch face={face} onChange={setFace} listId={listId} />
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
      {/* One list for both faces, so a focused row both faces show, such as
          a Waiting on you row, keeps its focus when the face changes. */}
      <SidebarList
        id={listId}
        label={face === "threads" ? "Threads" : "Hercule"}
        items={face === "threads" ? items : items.filter((item) => item.section === "waiting")}
        officeOpen={officeOpen}
        actions={listActions}
      >
        {face === "orchestration" ? (
          <>
            <WorkSection />
            <SystemSection />
          </>
        ) : (
          items.length === 0 && <p className="side-empty">No threads yet</p>
        )}
      </SidebarList>
      <DoneToastHost place="sidebar" />
      {face === "threads" && <AssistantsSection rows={assistantRows} officeOpen={officeOpen} />}
      <SidebarFoot
        working={presentation.counts.working}
        waiting={presentation.counts.waiting}
        idle={presentation.counts.idle}
        username={username}
      />
    </aside>
  );
});
