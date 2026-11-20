/**
 * PROTOTYPE, throwaway. Settings > MCP servers: the list in two shapes, the
 * page of one server, the list of a thread with no project, and the grid of
 * projects against servers.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { PlusIcon } from "../../icons/plus";
import { ProjectTile } from "../../screens/project-tile";
import {
  ConnMark,
  describeFix,
  isFailing,
  ServerMark,
  ServerName,
  StatusText,
  Toggle,
} from "./parts";
import {
  describeAddress,
  describeConnection,
  describeServerName,
  findConnectionServer,
  findNameClash,
  findServerConnection,
  finishCheck,
  listServerProjects,
  setDefaultServer,
  setProjectServer,
  setServer,
  type Conn,
  type Server,
  type World,
} from "./world";

/** What the Settings screens can ask of the app around them. */
export interface ServerActions {
  readonly onOpen: (serverId: string) => void;
  readonly onAdd: () => void;
  /** Switches the server a Connection offers on, which may first ask to replace a hand-added one. */
  readonly onSwitchOn: (connection: Conn) => void;
  readonly onFix: (server: Server) => void;
  readonly onRemove: (server: Server) => void;
  readonly onOpenConnections: () => void;
  /** Opens the picker of the servers a thread with no project starts with. */
  readonly onChangeDefault: () => void;
}

/** What each plugin's server does, in the plugin's own line. */
export const OFFER_LINES: Readonly<Record<string, string>> = {
  sentry: "Search and read issues, events and traces; update an issue.",
  linear: "Read, create and update issues, projects and comments.",
  github: "Read code, pull requests, issues and Actions runs; open a pull request.",
};

export const setEnabled = (server: Server, on: boolean): void => {
  if (on) finishCheck(server.id);
  else setServer(server.id, { status: "disabled", statusDetail: null });
};

/**
 * Draws the projects that name a server: one or two as tiles, and more as a
 * count, with the names in its tooltip. Three tiles do not fit the column.
 */
export function ProjectNames({
  w,
  server,
}: {
  readonly w: World;
  readonly server: Server;
}): JSX.Element {
  const projects = listServerProjects(w, server.id);
  if (projects.length === 0) return <span className="pm-projects is-none">None</span>;
  if (projects.length > 2) {
    return (
      <span className="pm-projects" title={projects.map((project) => project.name).join(", ")}>
        {projects.length} projects
      </span>
    );
  }
  return (
    <span className="pm-projects">
      {projects.map((project) => (
        <ProjectTile key={project.id} tint={project.tint} name={project.name} />
      ))}
    </span>
  );
}

export const countTools = (server: Server): string =>
  server.tools.length === 0 ? "–" : String(server.tools.length);

// ---------- The list ----------

/**
 * The list as one place for both sources: every Connection whose plugin
 * offers a server, on or off, then the servers added by URL.
 */
function ServerSwitchList({
  w,
  actions,
}: {
  readonly w: World;
  readonly actions: ServerActions;
}): JSX.Element {
  const offering = w.connections.filter((connection) => connection.offeredOrigin !== null);
  const added = w.servers.filter((server) => server.source.kind === "user");
  const head = (
    <div className="set-table-head pm-switch-head">
      <span />
      <span>Server</span>
      <span>Status</span>
      <span>Projects</span>
      <span className="pm-head-offered">Offered</span>
      <span />
    </div>
  );
  const serverRow = (server: Server, source: string): JSX.Element => (
    <a
      key={server.id}
      href="#"
      className={
        isFailing(server.status)
          ? "set-table-row pm-switch-row is-fail"
          : "set-table-row pm-switch-row"
      }
      onClick={(event) => {
        event.preventDefault();
        actions.onOpen(server.id);
      }}
    >
      <span className="profile-mark">
        <ServerMark server={server} />
      </span>
      <span className="profile-name">
        <ServerName name={server.name} account={findServerConnection(w, server)?.label} />
        <span>
          {source} · {countTools(server)} tools
        </span>
      </span>
      <StatusText server={server} />
      <ProjectNames w={w} server={server} />
      <Toggle
        on={server.status !== "disabled"}
        label={`Offer ${describeServerName(w, server)} to threads`}
        onChange={(on) => {
          setEnabled(server, on);
        }}
      />
      <ChevronRightIcon size={14} />
    </a>
  );
  return (
    <>
      <section className="pm-list-sec">
        <div className="pm-sec-top">
          <h2>From your Connections</h2>
          <span>No second sign-in: the server is reached with the Connection</span>
        </div>
        {head}
        {offering.map((connection) => {
          const server = findConnectionServer(w, connection.id);
          if (server !== undefined) return serverRow(server, `${connection.typeName} Connection`);
          // The Connection's server is not switched on yet. The row has the shape of the
          // others, under the name the server will get. It has no page yet, so it is no link
          // and has no chevron, and its second line says how to get one.
          return (
            <div
              key={connection.id}
              className="set-table-row pm-switch-row"
              title={OFFER_LINES[connection.pluginId]}
            >
              <span className="profile-mark">
                <ConnMark connection={connection} />
              </span>
              <span className="profile-name">
                <ServerName name={connection.pluginId} account={connection.label} />
                <span>{connection.typeName} Connection · switch it on to see its tools</span>
              </span>
              <span className="pm-status pm-status--off">off</span>
              <span className="pm-projects is-none">None</span>
              <Toggle
                on={false}
                label={`Switch on ${describeConnection(connection)}`}
                onChange={() => {
                  actions.onSwitchOn(connection);
                }}
              />
              <span />
            </div>
          );
        })}
      </section>
      <section className="pm-list-sec">
        <div className="pm-sec-top">
          <h2>Added by URL</h2>
          <span>Any remote MCP server, signed in once on the controller</span>
          <span className="spacer" />
          <button type="button" className="btn btn--sm" onClick={actions.onAdd}>
            <PlusIcon size={14} />
            Add by URL
          </button>
        </div>
        {added.length > 0 && head}
        {added.map((server) => serverRow(server, describeAddress(server)))}
        {added.length === 0 && (
          <div className="set-empty">
            <b>None added</b>
            <span>Add any remote MCP server by its address.</span>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * The servers a thread with no project gets: what is on the list, and a
 * button that opens the same picker a project uses.
 */
function DefaultList({
  w,
  onChange,
}: {
  readonly w: World;
  readonly onChange: () => void;
}): JSX.Element {
  const servers = w.servers.filter((server) => w.defaultServerIds.includes(server.id));
  return (
    <section className="pm-list-sec">
      <div className="pm-sec-top">
        <h2>Threads without a project</h2>
        <span>A thread in no project starts with these servers</span>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={onChange}>
          Change…
        </button>
      </div>
      <div className="pm-default-line">
        {servers.map((server) => (
          <span key={server.id} className="chip pm-server-chip">
            <ServerMark server={server} size={12} />
            <ServerName name={server.name} account={findServerConnection(w, server)?.label} />
          </span>
        ))}
        {servers.length === 0 && <span className="pm-projects is-none">None</span>}
      </div>
    </section>
  );
}

/** Settings > MCP servers, the list. */
export function ServersPage({
  w,
  keepsDefaultList,
  actions,
}: {
  readonly w: World;
  readonly keepsDefaultList: boolean;
  readonly actions: ServerActions;
}): JSX.Element {
  return (
    <div className="pm-servers">
      <p className="profile-lead">
        An MCP server gives agents tools from another service. Set one up here once and every runner
        has it: the sign-in stays on the controller. A project names the servers its threads start
        with.
        {keepsDefaultList ? "" : " A thread in no project starts with none."}
      </p>
      <ServerSwitchList w={w} actions={actions} />
      {keepsDefaultList && <DefaultList w={w} onChange={actions.onChangeDefault} />}
    </div>
  );
}

// ---------- One server's page ----------

/** The band over a server's page while it is not ready: why, and the one thing to do about it. */
function StatusBand({
  w,
  server,
  onFix,
}: {
  readonly w: World;
  readonly server: Server;
  readonly onFix: () => void;
}): JSX.Element | null {
  if (server.status === "ready") return null;
  if (server.status === "checking") {
    return (
      <div className="pm-band">
        <span className="spin" />
        <span>Checking: asking the server for its tools.</span>
      </div>
    );
  }
  if (server.status === "disabled") {
    return (
      <div className="pm-band">
        <span>
          <b>Off.</b> No thread gets this server. Its name, its sign-in and the projects that name
          it are kept.
        </span>
      </div>
    );
  }
  const fix = describeFix(w, server)!;
  return (
    <div className="pm-band pm-band--fail">
      <span>
        <b>{server.status === "needs-sign-in" ? "Needs sign-in." : "Unreachable."}</b> {fix.text}
        {server.statusDetail !== null && <small>{server.statusDetail}</small>}
      </span>
      <button type="button" className="btn btn--sm btn--accent" onClick={onFix}>
        {fix.action}
      </button>
    </div>
  );
}

const SIGN_IN_WORDS = { none: "None needed", token: "A token", oauth: "OAuth" } as const;

/**
 * What the Sign-in or Connection row shows while its server needs sign-in. It
 * stands for whatever the controller reports. The time is invented, as all
 * data here is.
 */
const REVOKED_WORDS = "revoked 09:12";

/**
 * The Projects section of a server's page: every project with a box, and the
 * threads without a project when Settings keeps a list for them. This is
 * where a project names a server. A project that names another server of
 * the same name refuses this one when its box is ticked, and offers the swap.
 */
function ServerProjects({
  w,
  server,
  keepsDefaultList,
  scrollsIntoView,
}: {
  readonly w: World;
  readonly server: Server;
  readonly keepsDefaultList: boolean;
  /** Whether the page opens on this section, as the Project scene does. */
  readonly scrollsIntoView: boolean;
}): JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollsIntoView) sectionRef.current?.scrollIntoView({ block: "start" });
  }, [scrollsIntoView]);
  // The row whose box the user ticked although its project names another server of this name.
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const rows: ReadonlyArray<{
    readonly key: string;
    readonly tile: ReactNode;
    readonly ids: readonly string[];
    readonly place: string;
    readonly set: (named: boolean) => void;
  }> = [
    ...w.projects.map((project) => ({
      key: project.id,
      tile: <ProjectTile tint={project.tint} name={project.name} />,
      ids: project.serverIds,
      place: project.name,
      set: (on: boolean) => {
        setProjectServer(project.id, server.id, on);
      },
    })),
    ...(keepsDefaultList
      ? [
          {
            key: "none",
            tile: <ProjectTile tint={null} name="Threads without a project" />,
            ids: w.defaultServerIds,
            place: "A thread without a project",
            set: (on: boolean) => {
              setDefaultServer(server.id, on);
            },
          },
        ]
      : []),
  ];
  return (
    <section ref={sectionRef} className="set-sec pm-projects-sec">
      <h2>
        Projects
        <small>
          {rows.filter((row) => row.ids.includes(server.id)).length} of {rows.length}
        </small>
      </h2>
      <p>
        A thread starts with this server when its project names it. A thread can still change its
        own list, under the plus of its composer.
      </p>
      {rows.map((row) => {
        const on = row.ids.includes(server.id);
        const clash = on ? undefined : findNameClash(w, row.ids, server);
        // The user ticked the box and the refusal under it waits for an answer.
        const waits = clash !== undefined && refusedKey === row.key;
        return (
          <div key={row.key} className="pm-proj-row">
            <label className="pm-proj-check">
              <span className={waits ? "choice-box pm-box-waiting" : "choice-box"}>
                <input
                  type="checkbox"
                  checked={on}
                  aria-checked={waits ? "mixed" : undefined}
                  onChange={(event) => {
                    // A project that names another server of this name cannot take this one too.
                    if (clash === undefined) {
                      setRefusedKey(null);
                      row.set(event.target.checked);
                    } else setRefusedKey(row.key);
                  }}
                />
                <CheckIcon size={11} />
              </span>
              {row.tile}
            </label>
            {clash !== undefined && !waits && (
              <span className="pm-proj-other">uses {describeServerName(w, clash)}</span>
            )}
            {clash !== undefined && waits && (
              <span className="pm-clash" role="alert">
                {row.place} already uses {describeServerName(w, clash)}. One project cannot name
                both: their tools would get the same names.
                <span className="pm-clash-acts">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setRefusedKey(null);
                      row.set(true);
                    }}
                  >
                    Use {describeServerName(w, server)}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setRefusedKey(null);
                    }}
                  >
                    Keep {describeServerName(w, clash)}
                  </button>
                </span>
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** The page of one MCP Server: its status, how it is reached, its tools, and the projects that name it. */
export function ServerPage({
  w,
  server,
  keepsDefaultList,
  opensOnProjects,
  actions,
}: {
  readonly w: World;
  readonly server: Server;
  readonly keepsDefaultList: boolean;
  /** Whether the page opens scrolled to its Projects section. */
  readonly opensOnProjects: boolean;
  readonly actions: ServerActions;
}): JSX.Element {
  const connection = findServerConnection(w, server);
  const { source } = server;
  const needsSignIn = server.status === "needs-sign-in";
  return (
    <div className="set-record pm-record">
      <div className="skill-lead">
        {/* The page names its server itself, large and where the eye lands. The Settings
            header names it too, but small and above the content, where it is easily missed. */}
        <div className="head">
          <span className="profile-mark pm-head-mark">
            <ServerMark server={server} size={20} />
          </span>
          <h2>
            <ServerName name={server.name} account={connection?.label} />
          </h2>
        </div>
        <div className="skill-chips">
          <span className="chip">
            {connection === undefined ? "Added by URL" : `From the ${connection.typeName} plugin`}
          </span>
          <span className="chip">{describeAddress(server)}</span>
        </div>
        <StatusBand
          w={w}
          server={server}
          onFix={() => {
            actions.onFix(server);
          }}
        />
      </div>

      <section className="set-sec">
        <h2>Server</h2>
        <div className="set-row">
          <div className="set-label">
            <b>Offered to threads</b>
            <span>Off keeps the name, the sign-in and the projects that name it.</span>
          </div>
          <Toggle
            on={server.status !== "disabled"}
            label="Offered to threads"
            onChange={(on) => {
              setEnabled(server, on);
            }}
          />
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Name</b>
            <span>
              Agents see its tools as <code>mcp__{server.name}__&lt;tool&gt;</code>.
            </span>
          </div>
          <span className="field">
            <input
              className="mono"
              spellCheck={false}
              aria-label="Name"
              value={server.name}
              onChange={(event) => {
                setServer(server.id, {
                  name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
                });
              }}
            />
          </span>
        </div>
        {connection !== undefined ? (
          <div className="set-row">
            <div className="set-label">
              <b>Connection</b>
              <span>The sign-in it acts through. No token leaves the controller.</span>
            </div>
            {needsSignIn ? (
              // The band above holds the page's one sign-in button, so this row only says what is wrong.
              <span className="pm-value">
                <ConnMark connection={connection} size={14} />
                <span className="pm-value-fail">{REVOKED_WORDS}</span>
                <span className="pm-value-fine">{connection.account}</span>
              </span>
            ) : (
              <>
                <span className="pm-value">
                  <ConnMark connection={connection} size={14} />
                  {describeConnection(connection)}
                  <span className="pm-value-fine">{connection.account}</span>
                </span>
                <button type="button" className="btn btn--sm" onClick={actions.onOpenConnections}>
                  Open
                </button>
              </>
            )}
          </div>
        ) : (
          source.kind === "user" && (
            <div className="set-row">
              <div className="set-label">
                <b>Sign-in</b>
                <span>Kept on the controller. No token reaches a runner.</span>
              </div>
              {needsSignIn ? (
                // The band above holds the page's one sign-in button, so this row only says what is wrong.
                <span className="pm-value">
                  <span className="pm-value-fail">{REVOKED_WORDS}</span>
                  {source.account !== null && (
                    <span className="pm-value-fine">{source.account}</span>
                  )}
                </span>
              ) : (
                <>
                  <span className="pm-value">
                    {SIGN_IN_WORDS[source.signIn]}
                    {source.account !== null && (
                      <span className="pm-value-fine">as {source.account}</span>
                    )}
                  </span>
                  {source.signIn !== "none" && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        actions.onFix(server);
                      }}
                    >
                      {source.signIn === "token" ? "Replace token…" : "Sign in again…"}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        )}
        <div className="set-row">
          <div className="set-label">
            <b>Last checked</b>
            <span>Hercule lists the tools again every hour, and when a call fails.</span>
          </div>
          <span className="pm-value">{server.checkedAt}</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={server.status === "checking" || server.status === "disabled"}
            onClick={() => {
              finishCheck(server.id);
            }}
          >
            Check now
          </button>
        </div>
      </section>

      <section className="set-sec">
        <h2>
          Tools
          <small>{server.tools.length}</small>
        </h2>
        <p>
          What the server offered when it was last checked. Agents get all of them: a tool cannot be
          switched off here.
        </p>
        <div>
          {server.tools.map((tool) => (
            <div key={tool.name} className="pm-tool">
              <code>{tool.name}</code>
              <span>{tool.description}</span>
            </div>
          ))}
          {server.tools.length === 0 && (
            <div className="pm-proj-row is-none">The tools show here once the check is done.</div>
          )}
        </div>
      </section>

      <ServerProjects
        w={w}
        server={server}
        keepsDefaultList={keepsDefaultList}
        scrollsIntoView={opensOnProjects}
      />

      <section className="set-sec">
        <h2>Remove</h2>
        <p>
          {connection === undefined
            ? "Deletes the server and its sign-in. Projects that name it stop naming it."
            : `Deletes the server. Projects that name it stop naming it. The Connection ${describeConnection(connection)} stays.`}
        </p>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            actions.onRemove(server);
          }}
        >
          Remove server…
        </button>
      </section>
    </div>
  );
}
