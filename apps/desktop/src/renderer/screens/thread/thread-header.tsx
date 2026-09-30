import { useId, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  listThreadTabs,
} from "@hercule/client-core";
import type { Runner, Session } from "@hercule/contract";
import { useAgeLabel, useAgeWords } from "../../app/age-clock";
import {
  projectsQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { EditorIcon, MoreIcon, PlusIcon } from "../../icons";
import { Mark } from "../../marks";
import { pickProjectTint, ProjectTile } from "../project-tile";
import "./thread-header.css";

/**
 * The classes a tab adds while its thread is open. The router also sets
 * `aria-current="page"` on it then.
 */
const SELECTED_TAB_PROPS = { className: "is-on" } as const;

/**
 * Renders the thread header: pills that float over the transcript, with no
 * bar behind them, as the Bureau book's `.top` draws them.
 *
 * - The first pill holds the thread's project, one tab per thread of the
 *   thread's workspace, in the workspace's order, and a `+` that opens a new
 *   thread in the workspace. A thread alone in its workspace, or in none, has
 *   one tab: its own. A thread in no workspace has no `+`.
 * - Open in editor and More are drawn but do nothing yet, and carry
 *   `aria-disabled` to say so.
 *
 * A long title ellipsizes, and the tabs shrink before the pills on the right
 * move. The lists it reads are in the cache before the thread screen renders,
 * so nothing here waits in practice.
 */
export function ThreadHeader({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;

  const tabs = listThreadTabs(session, threads, workspaces);
  const project = projects.find((each) => each.id === session.projectId);
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));

  return (
    <header className="top">
      <nav className="pill" aria-label="Threads in this workspace">
        <span className="pill-crumb">
          {project === undefined ? (
            <ProjectTile tint={null} name="No project" />
          ) : (
            <ProjectTile tint={pickProjectTint(project.id, projects)} name={project.name} />
          )}
        </span>
        {tabs.map((tab) => (
          <ThreadTab
            key={tab.id}
            session={tab}
            runner={tab.runnerId === null ? undefined : runnersById.get(tab.runnerId)}
          />
        ))}
        {session.workspaceId === null ? null : (
          <Link
            to="/"
            search={{ workspace: session.workspaceId }}
            className="icon-btn"
            title="New thread in this workspace"
          >
            <PlusIcon />
          </Link>
        )}
      </nav>
      <span className="spacer" />
      <span className="pill">
        <button type="button" className="icon-btn" title="Open in editor" aria-disabled="true">
          <EditorIcon />
        </button>
      </span>
      <span className="pill">
        <button type="button" className="icon-btn" title="More" aria-disabled="true">
          <MoreIcon />
        </button>
      </span>
    </header>
  );
}

/**
 * Renders one thread of the workspace as a tab: the mark of its pose, when
 * the pose has one, its title, and, when its sidebar row would not end in a
 * mark, the word or the age that row ends in.
 *
 * The tab is named "<title>, <pose words>", as the thread's sidebar row is,
 * and described by the word or the age in words, such as "20 minutes ago".
 * The mark says the pose, which the name already holds, so it is hidden.
 */
function ThreadTab({
  session,
  runner,
}: {
  readonly session: Session;
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
      aria-label={`${session.title}, ${describePose(pose)}`}
      aria-describedby={end.kind === "mark" ? undefined : endId}
    >
      {pose === "asleep" || pose === "away" ? null : <Mark state={pose} decorative />}
      <span className="ptab-title" title={session.title}>
        {session.title}
      </span>
      {end.kind === "mark" ? null : end.kind === "word" ? (
        <small id={endId}>{end.word}</small>
      ) : (
        <TabAge at={end.at} descriptionId={endId} />
      )}
    </Link>
  );
}

/**
 * Renders how long ago a tab's thread was last active: "20m" on screen, and
 * "20 minutes ago" in a hidden element with the id `descriptionId`, which the
 * tab's description points at. The header is always on screen, so the age
 * is always kept current.
 */
function TabAge({
  at,
  descriptionId,
}: {
  readonly at: string;
  readonly descriptionId: string;
}): JSX.Element {
  const label = useAgeLabel(at, true);
  const words = useAgeWords(at, true);
  return (
    <>
      <small>{label}</small>
      <span id={descriptionId} hidden>
        {words}
      </span>
    </>
  );
}
