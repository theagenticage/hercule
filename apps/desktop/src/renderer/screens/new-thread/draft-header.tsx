import type { JSX } from "react";
import type { Runner, Session } from "@hercule/contract";
import { ComposeIcon, MoreIcon } from "../../icons";
import type { ProjectTint } from "../project-tile";
import { ThreadTabsPill } from "../thread/thread-header";
import "../thread/thread-header.css";

/**
 * Renders a Draft Thread's header, as the Bureau book's `session-empty` page
 * draws it: one pill with the project, the threads of the workspace the
 * draft joins, and the draft's own "New thread" tab, selected; then More,
 * drawn but doing nothing yet.
 *
 * `project` is `null` for a draft in no project, which the crumb calls "No
 * project". `tabs` is empty unless the draft joins a workspace with threads.
 */
export function DraftHeader({
  project,
  tabs,
  runners,
}: {
  readonly project: { readonly name: string; readonly tint: ProjectTint } | null;
  readonly tabs: readonly Session[];
  readonly runners: readonly Runner[];
}): JSX.Element {
  return (
    <header className="top">
      <ThreadTabsPill project={project} tabs={tabs} runners={runners}>
        <span className="ptab is-on" aria-current="page">
          <ComposeIcon size={14} />
          New thread
        </span>
      </ThreadTabsPill>
      <span className="spacer" />
      <span className="pill">
        <button type="button" className="icon-btn" title="More" aria-disabled="true">
          <MoreIcon />
        </button>
      </span>
    </header>
  );
}
