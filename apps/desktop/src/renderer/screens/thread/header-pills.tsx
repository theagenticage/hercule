/**
 * The pills the thread's header and a Draft Thread's header both draw. They
 * sit apart from the thread's header so that the new-thread screen, which is
 * the first screen, loads only them. The thread's header loads with the
 * thread, together with the side pane's toggle and the Done button it draws.
 */
import { useId, useRef, type JSX, type ReactNode, type RefCallback } from "react";
import { Link } from "@tanstack/react-router";
import { isAbsentPose, isWaitingOnUser, type SessionTab } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import { ComposeIcon } from "../../icons/compose";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks";
import { AgeLabel } from "../age-label";
import { pickProjectTint, ProjectTile } from "../project-tile";
import { TabOverflowMenu } from "./tab-overflow-menu";
import { useTabOverflow } from "./use-tab-overflow";
import "../session/floating-header.css";
import "./thread-header.css";

/**
 * The key `useTabOverflow` finds the Draft Thread's "New thread" tab by. It
 * is no session id.
 */
const NEW_THREAD_TAB_KEY = "new-thread";

/** The open tab of a header: a session's tab, or a Draft Thread's own tab. */
type OpenTab =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "draft" };

/**
 * Renders a header's More pill. More is drawn but does nothing yet, and
 * carries `aria-disabled` to say so.
 */
export function MorePill(): JSX.Element {
  return (
    <span className="pill">
      <button type="button" className="icon-btn" title="More" aria-disabled="true">
        <MoreIcon />
      </button>
    </span>
  );
}

/**
 * Renders the crumb of a thread's or a draft's project: its tile, and its
 * name, which is "No project" when `projectId` is `null`. The tile's tint
 * follows the project's place in `projects`, as everywhere else.
 */
export function ProjectCrumb({
  projectId,
  projects,
}: {
  readonly projectId: string | null;
  readonly projects: readonly Project[];
}): JSX.Element {
  const project = projects.find((each) => each.id === projectId);
  return (
    <span className="pill-crumb">
      <ProjectTile
        tint={project === undefined ? null : pickProjectTint(project.id, projects)}
        name={project?.name ?? "No project"}
      />
    </span>
  );
}

/**
 * Renders a header's first pill, a nav named `label`: `crumbs`, the work's
 * name, one tab per session in `tabs`, the "+n" button for the tabs that do
 * not fit, then the "+" button. The pill sits in a room that takes the width the
 * header's buttons leave, less 24px (see thread-header.css).
 *
 * - `crumbs` are the place of the sessions: a project's crumb, or a run's.
 * - `workName` is the name of the work the tabs belong to, which a thread's
 *   sidebar row carries too. It is drawn after the crumbs with a separator
 *   after it, and left out, with the separator, when it is `null`.
 * - `tabs` are the tabs in their order. They come from the sidebar row's
 *   members, or, for a session with no row, from `listWorkspaceSessionTabs`.
 * - `open` is the open tab: a session's, or a Draft Thread's own "New thread"
 *   tab, which has no session yet and is drawn after the tabs only for a draft.
 * - `newThread` is the workspace and the project that the "+" button starts a
 *   thread in, or `null` for no "+" button.
 * - `freeSpace` is drawn in the room after the pill, such as "Syncing…". It
 *   takes only the room the pill leaves, so it never changes the fit.
 * - `className` adds classes to the nav, such as the one that styles a run's
 *   crumbs.
 *
 * The open tab and each waiting tab always stay in the pill. The tabs that
 * do not fit move behind "+n", in `TabOverflowMenu` (`useTabOverflow`).
 * The "+" button follows "+n" and always stays.
 */
export function ThreadTabsPill({
  label,
  className,
  crumbs,
  workName,
  tabs,
  open,
  newThread,
  freeSpace,
}: {
  readonly label: string;
  readonly className?: string | undefined;
  readonly crumbs: ReactNode;
  readonly workName: string | null;
  readonly tabs: readonly SessionTab[];
  readonly open: OpenTab;
  readonly newThread: { readonly projectId: string | null; readonly workspaceId: string } | null;
  readonly freeSpace?: ReactNode;
}): JSX.Element {
  const roomRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const openTabRef = useRef<HTMLElement | null>(null);
  const setOpenTab = (element: HTMLElement | null): void => {
    openTabRef.current = element;
  };
  const openKey = open.kind === "session" ? open.sessionId : NEW_THREAD_TAB_KEY;
  const hiddenKeys = useTabOverflow({
    roomRef,
    navRef,
    openKey,
    waitingKeys: tabs.filter(isWaitingOnUser).map((tab) => tab.sessionId),
  });
  return (
    <div ref={roomRef} className="thread-tabs-room">
      <nav
        ref={navRef}
        className={className === undefined ? "pill thread-tabs" : `pill thread-tabs ${className}`}
        aria-label={label}
      >
        {crumbs}
        {workName === null ? null : (
          <>
            <span className="work-name" data-work-name="" title={workName}>
              <span className="work-name-text">{workName}</span>
            </span>
            <span className="thread-tabs-sep" aria-hidden="true" />
          </>
        )}
        {tabs.map((tab) => (
          <SessionTabLink
            key={tab.sessionId}
            tab={tab}
            open={tab.sessionId === openKey}
            hidden={hiddenKeys.has(tab.sessionId)}
            tabRef={tab.sessionId === openKey ? setOpenTab : undefined}
          />
        ))}
        {open.kind === "draft" ? (
          // Not in the tab order, but focusable by script: the menu moves the focus here when
          // the last hidden tab returns while the focus was in the menu.
          <span
            ref={setOpenTab}
            className="ptab is-on"
            aria-current="page"
            data-tab={NEW_THREAD_TAB_KEY}
            tabIndex={-1}
          >
            <ComposeIcon size={14} />
            New thread
          </span>
        ) : null}
        <TabOverflowMenu
          tabs={tabs.filter((tab) => hiddenKeys.has(tab.sessionId))}
          openSessionId={open.kind === "session" ? open.sessionId : null}
          restoreFocus={() => openTabRef.current?.focus({ preventScroll: true })}
        />
        {newThread === null ? null : (
          <Link
            to="/"
            search={
              newThread.projectId === null
                ? { workspace: newThread.workspaceId }
                : { project: newThread.projectId, workspace: newThread.workspaceId }
            }
            className="icon-btn"
            title="New thread in this workspace"
          >
            <PlusIcon />
          </Link>
        )}
      </nav>
      {freeSpace}
    </div>
  );
}

/**
 * Renders one session as a tab, a link to its thread: the mark of its pose,
 * when the pose has one, its label, and, when the mark does not say it, the
 * word or the age that ends the session's sidebar line. A Thread marked Done
 * has the done mark and no end.
 *
 * - The tab is selected when `open` is true, from the open tab's key and not
 *   from the route, because the Office's drawer draws this header on the
 *   Office's route.
 * - `tabRef` receives the tab's element, for the open tab, so the menu can
 *   return the focus to it.
 * - A `hidden` tab stays in the header, out of flow and invisible, so
 *   `useTabOverflow` can still measure it. The menu of "+n" lists it. Its
 *   age does not tick while it is hidden.
 * - The tab is named `tab.accessibleName`, so someone who speaks the tab's
 *   name can say what they see. The tooltip is the full title. The word or
 *   the age that ends the tab describes it. The mark is hidden from
 *   assistive technology, because the name already says the state. A label
 *   that is no role of its own (`tab.hasRoleLabel` is false) is drawn
 *   lighter.
 */
function SessionTabLink({
  tab,
  open,
  hidden,
  tabRef,
}: {
  readonly tab: SessionTab;
  readonly open: boolean;
  readonly hidden: boolean;
  readonly tabRef: RefCallback<HTMLElement> | undefined;
}): JSX.Element {
  const endId = useId();
  const { sessionId, label, title, pose, status } = tab;
  // The mark says working and waiting, so only queued, offline and idle sessions need an end.
  const hasEnd =
    !tab.done && status !== "working" && status !== "approval" && status !== "question";
  const classes = ["ptab", open ? "is-on" : null, hidden ? "is-hidden" : null].filter(
    (name) => name !== null,
  );
  return (
    <Link
      ref={tabRef}
      to="/threads/$sessionId"
      params={{ sessionId }}
      className={classes.join(" ")}
      data-tab={sessionId}
      aria-current={open ? "page" : undefined}
      aria-label={tab.accessibleName}
      aria-describedby={hasEnd ? endId : undefined}
    >
      {tab.done ? <Mark state="done" /> : isAbsentPose(pose) ? null : <Mark state={pose} />}
      <span className={tab.hasRoleLabel ? "ptab-title" : "ptab-title is-title"} title={title}>
        {label}
      </span>
      {!hasEnd ? null : status === "age" ? (
        <AgeLabel at={tab.activityAt} onScreen={!hidden} descriptionId={endId} as="small" />
      ) : (
        <small id={endId}>{status}</small>
      )}
    </Link>
  );
}
