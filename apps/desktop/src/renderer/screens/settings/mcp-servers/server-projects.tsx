/**
 * The Projects section of a server's page (spec 17 §Settings, MCP servers):
 * one row for each project and one for the threads without a project, each
 * with a checkbox that says whether its list names the server. This is the
 * one place a project is given a server.
 */
import type { JSX, ReactNode } from "react";
import {
  describeProjectRefusal,
  type McpServerView,
  type ProjectBox,
} from "@hercule/client-core/mcp-servers";
import type { Project } from "@hercule/contract";
import { CheckIcon } from "../../../icons/check";
import { pickProjectTint, ProjectTile } from "../../project-tile";
import { TextParts } from "./server-parts";
import "./mcp-servers.css";

/**
 * Renders the section: its heading with "2 of 5" at the right, the line
 * under it, and `children`, the rows. `boxes` are the rows' boxes, which the
 * count reads.
 */
export function ProjectsSection({
  boxes,
  children,
}: {
  readonly boxes: readonly ProjectBox[];
  readonly children: ReactNode;
}): JSX.Element {
  const ticked = boxes.filter((box) => box.ticked).length;
  return (
    <section className="set-sec">
      <h2>
        Projects
        <small>{`${String(ticked)} of ${String(boxes.length)}`}</small>
      </h2>
      <p>
        A thread starts with this server when its project names it. A thread can still change its
        own list, under the plus of its composer.
      </p>
      {children}
    </section>
  );
}

/**
 * Renders one row of the Projects section: the checkbox, then the project's
 * tile, or the tile of the threads without a project.
 *
 * - A box ticked while its list names another server of the same name cannot
 *   be ticked: at rest the row says "uses sentry work". Pressing the box
 *   changes nothing but shows the refusal under the row (`refusing`), with
 *   "Use sentry hobby", which swaps the servers in one write, and "Keep
 *   sentry work", which closes the refusal. While the refusal shows, the box
 *   is neither ticked nor empty.
 * - While `busy`, the row's list is being written and its controls ignore
 *   presses. `error` is the reason for a write the controller refused.
 */
export function ProjectBoxRow({
  box,
  view,
  allProjects,
  refusing,
  busy,
  error,
  onTick,
  onUse,
  onKeep,
}: {
  readonly box: ProjectBox;
  /** The server of the page. */
  readonly view: McpServerView;
  readonly allProjects: readonly Project[];
  readonly refusing: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /** Called with the box's new state when the user presses the box. */
  readonly onTick: (ticked: boolean) => void;
  readonly onUse: () => void;
  readonly onKeep: () => void;
}): JSX.Element {
  const refusal = describeProjectRefusal(box, view);
  const waiting = refusal !== null && refusing;
  const { target } = box;
  const name = target.kind === "project" ? target.project.name : "Threads without a project";
  return (
    <div className="mcp-proj-row">
      <label className="mcp-proj-check">
        <span className={waiting ? "choice-box mcp-box-waiting" : "choice-box"}>
          <input
            type="checkbox"
            checked={box.ticked}
            aria-checked={waiting ? "mixed" : undefined}
            aria-disabled={busy}
            onChange={(event) => {
              if (!busy) onTick(event.target.checked);
            }}
          />
          <CheckIcon size={11} />
        </span>
        <ProjectTile
          tint={target.kind === "project" ? pickProjectTint(target.project.id, allProjects) : null}
          name={name}
        />
      </label>
      {box.takenBy !== null && !waiting && (
        <span className="mcp-proj-other">
          uses <code>{box.takenBy.server.name}</code>
          {box.takenBy.account !== undefined && (
            <>
              {" "}
              <code>{box.takenBy.account}</code>
            </>
          )}
        </span>
      )}
      {refusal !== null && waiting && (
        <span className="mcp-clash" role="alert">
          <TextParts parts={refusal.sentence} />
          <span className="mcp-clash-acts">
            <button
              type="button"
              className="btn btn--sm"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onUse();
              }}
            >
              <TextParts parts={refusal.use} />
            </button>
            <button type="button" className="btn btn--sm" onClick={onKeep}>
              <TextParts parts={refusal.keep} />
            </button>
          </span>
        </span>
      )}
      {error !== null && (
        <span className="mcp-clash" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
