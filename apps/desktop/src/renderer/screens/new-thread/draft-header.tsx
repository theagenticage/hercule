import type { JSX } from "react";
import type { GroupRow } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import { MorePill, ProjectCrumb, ThreadTabsPill } from "../thread/header-pills";
import "../session/floating-header.css";
import "../thread/thread-header.css";

/** The tabs of a draft that joins no row. */
const NO_TABS: GroupRow["members"] = [];

/**
 * Renders a Draft Thread's header, as the Bureau book's `session-empty` page
 * draws it: one pill with the project, the work's name and the tabs of the
 * workspace the draft joins, then the draft's own "New thread" tab, selected;
 * then More, drawn but doing nothing yet.
 *
 * `projectId` is `null` for a draft in no project, which the crumb calls "No
 * project"; `projects` is the project list the crumb finds it in. `row` is
 * the sidebar row of the workspace the draft joins. Its title is the work's
 * name and its members are the tabs, as in the header of its threads, so the
 * header does not change when the first message is sent. Without a row, such
 * as for a new workspace, the pill holds the crumb and the New thread tab.
 */
export function DraftHeader({
  projectId,
  projects,
  row,
}: {
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly row: GroupRow | undefined;
}): JSX.Element {
  return (
    <header className="top">
      <ThreadTabsPill
        label="Threads in this workspace"
        crumbs={<ProjectCrumb projectId={projectId} projects={projects} />}
        workName={row?.title ?? null}
        tabs={row?.members ?? NO_TABS}
        openId={null}
        newThreadTab
      />
      <MorePill />
    </header>
  );
}
