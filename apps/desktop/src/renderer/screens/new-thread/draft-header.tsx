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
 * `row` is the sidebar row of the workspace the draft joins. Its title is the
 * work's name, its project is the crumb's project and its members are the
 * tabs, as in the header of its threads, so the header does not change when
 * the first message is sent. The row's project may be none, and then the
 * crumb says "No project" whatever `projectId` is. Without a row, such as for
 * a new workspace, the crumb shows `projectId`, which is `null` for a draft
 * in no project, and the pill holds the crumb and the New thread tab.
 * `projects` is the project list the crumb finds the project in.
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
        label="Sessions in this workspace"
        crumbs={
          <ProjectCrumb
            projectId={row === undefined ? projectId : row.projectId}
            projects={projects}
          />
        }
        workName={row?.title ?? null}
        tabs={row?.members ?? NO_TABS}
        open={{ kind: "draft" }}
        newThread={null}
      />
      <MorePill />
    </header>
  );
}
