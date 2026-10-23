/**
 * The pills the thread's header and a Draft Thread's header both draw. They
 * sit apart from the thread's header so that the new-thread screen, which is
 * the first screen, loads only them. The thread's header loads with the
 * thread, together with the side pane's toggle it draws.
 */
import { useId, type JSX, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  isAbsentPose,
  labelWorkspaceSessions,
} from "@hercule/client-core";
import type { Project, Runner, Session } from "@hercule/contract";
import { MoreIcon } from "../../icons/more";
import { Mark } from "../../marks";
import { AgeLabel } from "../age-label";
import { pickProjectTint, ProjectTile } from "../project-tile";
import "../session/floating-header.css";
import "./thread-header.css";

/**
 * The classes a tab adds while its thread is open. The router also sets
 * `aria-current="page"` on it then.
 */
const SELECTED_TAB_PROPS = { className: "is-on" } as const;

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
 * Renders a header's first pill, a nav named `label`: `crumbs`, then one tab
 * per session in `tabs`, then `children`.
 *
 * - `crumbs` are the place of the sessions: a project's crumb, or a run's.
 * - `className` adds classes to the nav, such as the one that styles a run's
 *   crumbs.
 * - Each tab's pose is drawn with the runner it names in `runners`.
 * - `workspaceSessions` is every session of the workspace, exited ones and
 *   Agent sessions too, not only the tabs. A tab's label is numbered among
 *   them, so it reads as it does in the sidebar.
 */
export function ThreadTabsPill({
  label,
  className,
  crumbs,
  tabs,
  workspaceSessions,
  runners,
  children,
}: {
  readonly label: string;
  readonly className?: string | undefined;
  readonly crumbs: ReactNode;
  readonly tabs: readonly Session[];
  readonly workspaceSessions: readonly Session[];
  readonly runners: readonly Runner[];
  readonly children?: ReactNode;
}): JSX.Element {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const labels = labelWorkspaceSessions(workspaceSessions);
  return (
    <nav
      className={className === undefined ? "pill thread-tabs" : `pill thread-tabs ${className}`}
      aria-label={label}
    >
      {crumbs}
      {tabs.map((tab) => (
        <ThreadTab
          key={tab.id}
          session={tab}
          label={labels.get(tab.id) ?? tab.title}
          runner={tab.runnerId === null ? undefined : runnersById.get(tab.runnerId)}
        />
      ))}
      {children}
    </nav>
  );
}

/**
 * Renders one session of the workspace as a tab: the mark of its pose, when
 * the pose has one, its label, and, when its sidebar row would not end in a
 * mark, the word or the age that row ends in.
 *
 * The tab is named "<title>, <pose words>", as the session's sidebar row is.
 * When the label is the session's role, the name starts with it, "review 2,
 * <title>, <pose words>", so someone who speaks the tab's name can say what
 * they see. The tooltip keeps the full title. The tab is described by the
 * word or the age in words, such as "20 minutes ago". The mark says the pose,
 * which the name already holds, so it is hidden.
 */
function ThreadTab({
  session,
  label,
  runner,
}: {
  readonly session: Session;
  /** The tab's text, as `labelWorkspaceSessions` returns it for the workspace's sessions. */
  readonly label: string;
  readonly runner: Runner | undefined;
}): JSX.Element {
  const endId = useId();
  const pose = decideThreadPose(session, runner);
  const end = decideThreadRowEnd(session, runner);
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId: session.id }}
      className="ptab"
      activeProps={SELECTED_TAB_PROPS}
      aria-label={
        session.kind !== "run" && label !== session.title
          ? `${label}, ${session.title}, ${describePose(pose)}`
          : `${session.title}, ${describePose(pose)}`
      }
      aria-describedby={end.kind === "mark" ? undefined : endId}
    >
      {isAbsentPose(pose) ? null : <Mark state={pose} />}
      <span className="ptab-title" title={session.title}>
        {label}
      </span>
      {end.kind === "mark" ? null : end.kind === "word" ? (
        <small id={endId}>{end.word}</small>
      ) : (
        <AgeLabel at={end.at} onScreen descriptionId={endId} as="small" />
      )}
    </Link>
  );
}
