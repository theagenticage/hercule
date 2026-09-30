import type { JSX } from "react";
import type { Project, Runner, Session } from "@hercule/contract";
import { ComposeIcon } from "../../icons";
import { MorePill, ThreadTabsPill } from "../thread/thread-header";
import "../thread/thread-header.css";

/**
 * Renders a Draft Thread's header, as the Bureau book's `session-empty` page
 * draws it: one pill with the project, the threads of the workspace the
 * draft joins, and the draft's own "New thread" tab, selected; then More,
 * drawn but doing nothing yet.
 *
 * `projectId` is `null` for a draft in no project, which the crumb calls "No
 * project"; `projects` is the project list the crumb finds it in. `tabs` is
 * empty unless the draft joins a workspace with threads.
 */
export function DraftHeader({
  projectId,
  projects,
  tabs,
  runners,
}: {
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly tabs: readonly Session[];
  readonly runners: readonly Runner[];
}): JSX.Element {
  return (
    <header className="top">
      <ThreadTabsPill projectId={projectId} projects={projects} tabs={tabs} runners={runners}>
        <span className="ptab is-on" aria-current="page">
          <ComposeIcon size={14} />
          New thread
        </span>
      </ThreadTabsPill>
      <span className="spacer" />
      <MorePill />
    </header>
  );
}
