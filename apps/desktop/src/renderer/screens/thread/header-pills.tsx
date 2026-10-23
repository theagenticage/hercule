/**
 * The pills the thread's header and a Draft Thread's header both draw. They
 * sit apart from the thread's header so that the new-thread screen, which is
 * the first screen, loads only them. The thread's header loads with the
 * thread, together with the side pane's toggle and the Done button it draws.
 */
import { useId, useRef, type JSX, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { describePose, isAbsentPose, type SessionTab } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import { ComposeIcon } from "../../icons/compose";
import { MoreIcon } from "../../icons/more";
import { Mark } from "../../marks";
import { AgeLabel } from "../age-label";
import { pickProjectTint, ProjectTile } from "../project-tile";
import { TabOverflowMenu } from "./tab-overflow-menu";
import { useTabOverflow } from "./use-tab-overflow";
import "../session/floating-header.css";
import "./thread-header.css";

/** The key of the Draft Thread's "New thread" tab, which `useTabOverflow` finds it by. */
const NEW_THREAD_TAB_KEY = "new-thread";

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
 * not fit, then `children`. The pill sits in a room that takes the width the
 * header's buttons leave, less 24px (see thread-header.css).
 *
 * - `crumbs` are the place of the sessions: a project's crumb, or a run's.
 * - `workName` is the name of the work the tabs belong to, which a thread's
 *   sidebar row carries too. It is drawn after the crumbs with a separator
 *   after it, and left out, with the separator, when it is `null`.
 * - `tabs` are the tabs in their order. They come from the sidebar row's
 *   members, or, for a session with no row, from `listWorkspaceSessionTabs`.
 * - `openId` is the open session, whose tab is selected. It is `null` for a
 *   Draft Thread, which has no session yet.
 * - `newThreadTab` draws the Draft Thread's own "New thread" tab after the
 *   tabs. It is the open tab, so `openId` is `null` with it.
 * - `freeSpace` is drawn in the room after the pill, such as "Syncing…". It
 *   takes only the room the pill leaves, so it never changes the fit.
 * - `className` adds classes to the nav, such as the one that styles a run's
 *   crumbs.
 *
 * The open tab and each waiting tab always stay in the pill. The tabs that
 * do not fit move behind "+n", in `TabOverflowMenu` (`useTabOverflow`).
 * `children` follow "+n" and always stay, such as the button for a new thread.
 */
export function ThreadTabsPill({
  label,
  className,
  crumbs,
  workName,
  tabs,
  openId,
  newThreadTab,
  freeSpace,
  children,
}: {
  readonly label: string;
  readonly className?: string | undefined;
  readonly crumbs: ReactNode;
  readonly workName: string | null;
  readonly tabs: readonly SessionTab[];
  readonly openId: string | null;
  readonly newThreadTab?: boolean | undefined;
  readonly freeSpace?: ReactNode;
  readonly children?: ReactNode;
}): JSX.Element {
  const roomRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const hasNewThreadTab = newThreadTab === true;
  const openKey = hasNewThreadTab ? NEW_THREAD_TAB_KEY : openId;
  const hiddenKeys = useTabOverflow({
    roomRef,
    navRef,
    openKey,
    waitingKeys: tabs.filter((tab) => tab.pose === "waiting").map((tab) => tab.sessionId),
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
          <ThreadTab
            key={tab.sessionId}
            tab={tab}
            open={tab.sessionId === openId}
            hidden={hiddenKeys.has(tab.sessionId)}
          />
        ))}
        {hasNewThreadTab ? (
          <span className="ptab is-on" aria-current="page" data-tab={NEW_THREAD_TAB_KEY}>
            <ComposeIcon size={14} />
            New thread
          </span>
        ) : null}
        <TabOverflowMenu
          tabs={tabs.filter((tab) => hiddenKeys.has(tab.sessionId))}
          openId={openId}
        />
        {children}
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
 * - The tab is selected when `open` is true, from the open session's id and
 *   not from the route, because the Office's drawer draws this header on the
 *   Office's route.
 * - A `hidden` tab stays in the header, out of flow and invisible, so
 *   `useTabOverflow` can still measure it. The menu of "+n" lists it.
 * - The tab is named "<label>, <title>, <state>", or "<title>, <state>" when
 *   the label is the title because the session has no role, so someone who
 *   speaks the tab's name can say what they see. The state is "done" or the
 *   pose in words. The tooltip is the full title. The word or the age that
 *   ends the tab describes it. The mark is hidden from assistive technology,
 *   because the name already says the state.
 */
function ThreadTab({
  tab,
  open,
  hidden,
}: {
  readonly tab: SessionTab;
  readonly open: boolean;
  readonly hidden: boolean;
}): JSX.Element {
  const endId = useId();
  const { sessionId, label, title, pose, status } = tab;
  const titleOnly = label === title;
  const state = tab.done ? "done" : describePose(pose);
  // The mark says working and waiting, so only queued, offline and idle sessions need an end.
  const hasEnd =
    !tab.done && status !== "working" && status !== "approval" && status !== "question";
  const classes = ["ptab", open ? "is-on" : null, hidden ? "is-hidden" : null].filter(
    (name) => name !== null,
  );
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      className={classes.join(" ")}
      data-tab={sessionId}
      aria-current={open ? "page" : undefined}
      aria-label={titleOnly ? `${title}, ${state}` : `${label}, ${title}, ${state}`}
      aria-describedby={hasEnd ? endId : undefined}
    >
      {tab.done ? <Mark state="done" /> : isAbsentPose(pose) ? null : <Mark state={pose} />}
      <span className={titleOnly ? "ptab-title is-title" : "ptab-title"} title={title}>
        {label}
      </span>
      {!hasEnd ? null : status === "age" ? (
        <AgeLabel at={tab.activityAt} onScreen descriptionId={endId} as="small" />
      ) : (
        <small id={endId}>{status}</small>
      )}
    </Link>
  );
}
