/**
 * The list of Settings > MCP servers (spec 17 §Settings, MCP servers): the
 * lead, the group "From your Connections" with one row for each Connection
 * whose plugin offers a server, the group "Added by URL", and the group
 * "Threads without a project". The route draws one `ServerRowView` or
 * `UrlServerRowView` for each row, because each row's switch owns a write.
 */
import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { PluginIdentity } from "@hercule/client-core";
import {
  describeNamingProjects,
  type McpServerSettingsRow,
  type McpServerView,
  type UrlServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import type { Project } from "@hercule/contract";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { PlusIcon } from "../../../icons/plus";
import { ToolsIcon } from "../../../icons/tools";
import { PluginMark } from "../../../marks/plugin-mark";
import { pickProjectTint, ProjectTile } from "../../project-tile";
import { readNameAccount, ServerName, ServerStatus, ServerSwitch } from "./server-parts";
import "../permission-profiles/permission-profiles.css";
import "./mcp-servers.css";

/** Renders the lead (spec 17's wording), then `children`, the list's groups in order. */
export function ServerList({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="mcp-list">
      <p className="profile-lead">
        An MCP server gives agents tools from another service. Set one up here once and every runner
        has it: the sign-in stays on the controller. A project names the servers its new threads
        start with.
      </p>
      {children}
    </div>
  );
}

/**
 * Renders the group "From your Connections": its heading and line, the
 * table's head, and `children`, the rows. With `isEmpty`, no row follows the
 * head: no Connection has a plugin that offers a server, so a note says where
 * a row comes from.
 */
export function ConnectionServers({
  isEmpty,
  children,
}: {
  readonly isEmpty: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="mcp-group" aria-label="From your Connections">
      <div className="mcp-group-top">
        <h2>From your Connections</h2>
        <span>No second sign-in: the server is reached with the Connection</span>
      </div>
      {isEmpty ? (
        <div className="set-empty">
          <b>No Connection offers a server yet</b>
          <span>
            {
              "A row appears here for each Connection of a plugin that offers an MCP server, such as Sentry. Add one in Settings > Connections."
            }
          </span>
        </div>
      ) : (
        <>
          <div className="set-table-head mcp-row-grid">
            <span />
            <span>Server</span>
            <span>Status</span>
            <span>Projects</span>
            <span className="mcp-head-offered">Offered</span>
            <span />
          </div>
          {children}
        </>
      )}
    </section>
  );
}

/** Returns the value of `data-offer-row` of the row of the offer `contributionId` on the Connection `connectionId`. */
const buildOfferRowKey = (contributionId: string, connectionId: string): string =>
  `${contributionId}:${connectionId}`;

/**
 * Scrolls the row of the offer `contributionId` on the Connection
 * `connectionId` into view and moves the focus to its switch, so the user
 * sees where to switch the server on. Does nothing when the list draws no
 * such row.
 */
export function showOfferRow(contributionId: string, connectionId: string): void {
  const row = document.querySelector<HTMLElement>(
    `[data-offer-row="${CSS.escape(buildOfferRowKey(contributionId, connectionId))}"]`,
  );
  if (row === null) return;
  row.scrollIntoView({ block: "center" });
  row.querySelector<HTMLElement>('[role="switch"]')?.focus();
}

/**
 * Renders what the "Projects" cell shows for the projects that name a server:
 * "None", one or two project tiles, or a count with the names as its tooltip.
 * `allProjects` is every project, in order, which decides each tile's tint.
 */
function ProjectNames({
  projects,
  allProjects,
}: {
  readonly projects: readonly Project[];
  readonly allProjects: readonly Project[];
}): JSX.Element {
  const naming = describeNamingProjects(projects);
  switch (naming.kind) {
    case "none":
      return <span className="mcp-projects is-none">{naming.text}</span>;
    case "count":
      return (
        <span className="mcp-projects" title={naming.tooltip}>
          {naming.text}
        </span>
      );
    case "tiles":
      return (
        <span className="mcp-projects">
          {naming.projects.map((project) => (
            <ProjectTile
              key={project.id}
              tint={pickProjectTint(project.id, allProjects)}
              name={project.name}
            />
          ))}
        </span>
      );
  }
}

/**
 * Renders one row of "From your Connections".
 *
 * - The mark, the name with the Connection's label, and the second line
 *   ("Sentry Connection · 5 tools", or "Sentry Connection · switch it on to
 *   see its tools" while the server has no record).
 * - The status, the projects that name the server, and the switch.
 * - A row with a record leads to the server's page, from its name and a
 *   chevron: the link covers the whole row, and the switch sits above it, so
 *   a press anywhere but the switch opens the page. A row with no record has
 *   no page and no chevron.
 * - A failing server tints the row, as a failing Connection does.
 * - `busy` is true while the row's write runs. `refusal` is the controller's
 *   reason for the last write it refused, shown under the row.
 */
export function ServerRowView({
  row,
  plugins,
  allProjects,
  busy,
  refusal,
  onFlip,
}: {
  readonly row: McpServerSettingsRow;
  readonly plugins: readonly PluginIdentity[];
  readonly allProjects: readonly Project[];
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onFlip: () => void;
}): JSX.Element {
  const { view } = row;
  const account = row.connection.label;
  const nameCell = (
    <>
      <ServerName name={row.name} account={account} />
      <span>{row.secondLine}</span>
    </>
  );
  return (
    <>
      <div
        data-offer-row={buildOfferRowKey(row.offer.contributionId, row.connection.id)}
        className={
          view?.failing === true
            ? "set-table-row mcp-row mcp-row-grid is-fail"
            : "set-table-row mcp-row mcp-row-grid"
        }
      >
        <span className="profile-mark">
          <PluginMark pluginId={row.offer.pluginId} plugins={plugins} size={16} />
        </span>
        {view === null ? (
          <span className="profile-name">{nameCell}</span>
        ) : (
          <Link
            to="/settings/mcp-servers/$id"
            params={{ id: view.server.id }}
            className="profile-name mcp-row-link"
          >
            {nameCell}
          </Link>
        )}
        <ServerStatus
          displayStatus={view?.displayStatus ?? "off"}
          word={row.statusWord}
          failing={view?.failing ?? false}
          detail={view?.statusDetail ?? null}
        />
        <ProjectNames projects={row.projects} allProjects={allProjects} />
        <ServerSwitch
          on={view?.server.enabled ?? false}
          label={`Offer ${row.name} ${account} to threads`}
          busy={busy}
          onFlip={onFlip}
        />
        {view === null ? <span /> : <ChevronRightIcon size={14} />}
      </div>
      {refusal !== null && (
        <p className="mcp-row-refusal" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}

/**
 * Renders the group "Added by URL": its heading and line, "Add by URL" at the
 * right of the heading, the table's head, and `children`, the rows. With
 * `isEmpty`, no table follows: the block says what the group is for.
 * `onAdd` is called when "Add by URL" is pressed.
 */
export function UrlServers({
  isEmpty,
  onAdd,
  children,
}: {
  readonly isEmpty: boolean;
  readonly onAdd: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="mcp-group" aria-label="Added by URL">
      <div className="mcp-group-top">
        <h2>Added by URL</h2>
        <span>Any remote MCP server, signed in once on the controller</span>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={onAdd}>
          <PlusIcon size={13} />
          Add by URL
        </button>
      </div>
      {isEmpty ? (
        <div className="set-empty">
          <b>None added</b>
          <span>Add any remote MCP server by its address.</span>
        </div>
      ) : (
        <>
          <div className="set-table-head mcp-row-grid">
            <span />
            <span>Server</span>
            <span>Status</span>
            <span>Projects</span>
            <span className="mcp-head-offered">Offered</span>
            <span />
          </div>
          {children}
        </>
      )}
    </section>
  );
}

/**
 * Renders one row of "Added by URL": the tools mark, the name with the whole
 * address and the tool count under it, the status, the projects that name
 * the server, and the switch. The row leads to the server's page as a row
 * of "From your Connections" with a record does. `busy` is true while the
 * row's write runs, and `refusal` is the controller's reason for the last
 * write it refused, shown under the row.
 */
export function UrlServerRowView({
  row,
  allProjects,
  busy,
  refusal,
  onFlip,
}: {
  readonly row: UrlServerSettingsRow;
  readonly allProjects: readonly Project[];
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onFlip: () => void;
}): JSX.Element {
  const { view } = row;
  const { name } = view.server;
  return (
    <>
      <div
        className={
          view.failing
            ? "set-table-row mcp-row mcp-row-grid is-fail"
            : "set-table-row mcp-row mcp-row-grid"
        }
      >
        <span className="profile-mark">
          <ToolsIcon size={16} />
        </span>
        <Link
          to="/settings/mcp-servers/$id"
          params={{ id: view.server.id }}
          className="profile-name mcp-row-link"
        >
          <ServerName name={name} account={readNameAccount(view)} />
          <span>{view.secondLine}</span>
        </Link>
        <ServerStatus
          displayStatus={view.displayStatus}
          word={view.statusWord}
          failing={view.failing}
          detail={view.statusDetail}
        />
        <ProjectNames projects={row.projects} allProjects={allProjects} />
        <ServerSwitch
          on={view.server.enabled}
          label={`Offer ${name} to threads`}
          busy={busy}
          onFlip={onFlip}
        />
        <ChevronRightIcon size={14} />
      </div>
      {refusal !== null && (
        <p className="mcp-row-refusal" role="alert">
          {refusal}
        </p>
      )}
    </>
  );
}

/**
 * Renders the group "Threads without a project": its line, the servers of
 * the default list as chips with their marks, or "None", and Change…, which
 * calls `onChange`. `chosen` are the servers of `thread.mcpServerIds`.
 * While `changeOff`, Change… ignores presses: the list drawn may be older than
 * the controller's, and a change would be built on it.
 */
export function DefaultServers({
  chosen,
  plugins,
  changeOff,
  onChange,
}: {
  readonly chosen: readonly McpServerView[];
  readonly plugins: readonly PluginIdentity[];
  readonly changeOff: boolean;
  readonly onChange: () => void;
}): JSX.Element {
  return (
    <section className="mcp-group" aria-label="Threads without a project">
      <div className="mcp-group-top">
        <h2>Threads without a project</h2>
        <span>A thread in no project starts with these servers</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={changeOff}
          onClick={() => {
            if (!changeOff) onChange();
          }}
        >
          Change…
        </button>
      </div>
      <div className="mcp-default-line">
        {chosen.map((view) => (
          <span key={view.server.id} className="chip mcp-chip">
            <PluginMark pluginId={view.pluginId} plugins={plugins} size={12} />
            <ServerName name={view.server.name} account={readNameAccount(view)} />
          </span>
        ))}
        {chosen.length === 0 && <span className="mcp-projects is-none">None</span>}
      </div>
    </section>
  );
}
