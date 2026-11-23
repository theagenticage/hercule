/**
 * The parts of a server's page in Settings > MCP servers (spec 17 §Settings,
 * MCP servers): the heading with its chips and status band, the Server
 * section, and Tools. The Projects section is in `server-projects.tsx`; the
 * Remove section belongs to the route, which owns its confirmation.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { showsAccountBesideLabel, type PluginIdentity } from "@hercule/client-core";
import {
  describeConnectionRowProblem,
  isCheckDisabled,
  type McpServerView,
  type StatusBand,
  type StatusBandAction,
} from "@hercule/client-core/mcp-servers";
import { useAgeWords } from "../../../app/age-clock";
import { PluginMark } from "../../../marks/plugin-mark";
import { ServerName, ServerSwitch } from "./server-parts";
// The head's mark is the list's `.profile-mark`. A page opened on its own, from a thread's "Open
// server", does not load the list's code, so the page loads this file itself.
import "../permission-profiles/permission-profiles.css";
import "./mcp-servers.css";

/**
 * Renders the head of the page, where the eye lands: the server's mark and
 * its name with its account, large, under it two chips, the plugin the
 * server comes from and its `address`, and then the status `band`, when the
 * server has one.
 *
 * `address` is `null` when no plugin offers the server any more. While
 * `busy`, the band's button is already running its action.
 */
export function ServerHead({
  view,
  plugins,
  address,
  band,
  busy,
  onBandAction,
}: {
  readonly view: McpServerView;
  readonly plugins: readonly PluginIdentity[];
  readonly address: string | null;
  readonly band: StatusBand | null;
  readonly busy: boolean;
  readonly onBandAction: (action: StatusBandAction) => void;
}): JSX.Element {
  return (
    <div className="mcp-lead">
      {/* The page names its server itself, large and where the eye lands. The
          Settings header names it too, but small and above the content. */}
      <div className="head">
        <span className="profile-mark mcp-head-mark">
          <PluginMark pluginId={view.pluginId} plugins={plugins} size={20} />
        </span>
        <h2>
          <ServerName name={view.server.name} account={view.account} />
        </h2>
      </div>
      <div className="mcp-chips">
        <span className="chip">{`From the ${view.typeName} plugin`}</span>
        {address !== null && <span className="chip">{address}</span>}
      </div>
      {band !== null && (
        <div className={band.tone === "fail" ? "mcp-band mcp-band--fail" : "mcp-band"}>
          {view.displayStatus === "checking" && <span className="spin" />}
          <span>
            {band.heading !== null && <b>{band.heading}</b>}
            {band.heading !== null && " "}
            {band.text}
            {band.detail !== null && <small>{band.detail}</small>}
          </span>
          {band.action !== null && (
            <button
              type="button"
              className="btn btn--sm btn--accent"
              aria-disabled={busy}
              onClick={() => {
                if (!busy && band.action !== null) onBandAction(band.action);
              }}
            >
              {band.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders the age of `at` in words, such as "20 minutes ago", kept current by the age clock. */
function CheckedAge({ at }: { readonly at: string }): JSX.Element {
  return <span className="mcp-value">{useAgeWords(at, true)}</span>;
}

/**
 * Renders the Server section of a page: whether the server is offered to
 * threads, its name, the Connection it is reached with, and when it was last
 * checked, with Check now.
 *
 * - The switch shows `switchOn`, the server's `enabled` in the list of servers.
 *   While `switchBusy`, it is unavailable: its write runs, or this page's own
 *   read of the server is behind the list.
 * - The Connection row shows the Connection and Open, which leads to
 *   Settings > Connections. While the server needs sign-in it shows what is
 *   wrong instead, in `--fail`, and no button: the band holds the page's one
 *   button.
 * - Check now is off while the server is checking or switched off, and while
 *   `checkBusy`.
 * - `switchError` and `checkError` are the controller's reasons for a write it
 *   refused, shown under the row that made it.
 */
export function ServerSection({
  view,
  plugins,
  switchOn,
  switchBusy,
  switchError,
  checkBusy,
  checkError,
  onFlipSwitch,
  onCheck,
}: {
  readonly view: McpServerView;
  readonly plugins: readonly PluginIdentity[];
  readonly switchOn: boolean;
  readonly switchBusy: boolean;
  readonly switchError: string | null;
  readonly checkBusy: boolean;
  readonly checkError: string | null;
  readonly onFlipSwitch: () => void;
  readonly onCheck: () => void;
}): JSX.Element {
  const { connection, server } = view;
  const cannotCheck = checkBusy || isCheckDisabled(view);
  const connectionProblem = describeConnectionRowProblem(view);
  return (
    <section className="set-sec">
      <h2>Server</h2>
      <div className="set-row">
        <div className="set-label">
          <b>Offered to threads</b>
          <span>Off keeps the name, the sign-in and the projects that name it.</span>
        </div>
        <ServerSwitch
          on={switchOn}
          label="Offered to threads"
          busy={switchBusy}
          onFlip={onFlipSwitch}
        />
      </div>
      {switchError !== null && (
        <p className="set-err" role="alert">
          {switchError}
        </p>
      )}
      <div className="set-row">
        <div className="set-label">
          <b>Name</b>
          <span>
            Agents see its tools as <code>{"mcp__tools__<name>__<tool>"}</code>.
          </span>
        </div>
        <code className="mcp-value mcp-value--mono">{server.name}</code>
      </div>
      {connection !== undefined && (
        <div className="set-row">
          <div className="set-label">
            <b>Connection</b>
            <span>The sign-in it acts through. No token leaves the controller.</span>
          </div>
          <span className="mcp-value">
            <PluginMark pluginId={view.pluginId} plugins={plugins} size={14} />
            <span className="mcp-connection">
              {connectionProblem !== null ? (
                <span className="mcp-value-fail">{connectionProblem}</span>
              ) : (
                <span>{`${view.typeName} · ${connection.label}`}</span>
              )}
              {showsAccountBesideLabel(connection) && (
                <span className="mcp-value-fine">{connection.displayName}</span>
              )}
            </span>
          </span>
          {connectionProblem === null && (
            <Link to="/settings/connections" className="btn btn--sm">
              Open
            </Link>
          )}
        </div>
      )}
      <div className="set-row">
        <div className="set-label">
          <b>Last checked</b>
          <span>
            Hercule lists the tools again once a day, and when the Connection or the sign-in
            changes.
          </span>
        </div>
        {server.checkedAt === null ? (
          <span className="mcp-value">Not yet</span>
        ) : (
          <CheckedAge at={server.checkedAt} />
        )}
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={cannotCheck}
          data-unready={cannotCheck || undefined}
          onClick={() => {
            if (!cannotCheck) onCheck();
          }}
        >
          Check now
        </button>
      </div>
      {checkError !== null && (
        <p className="set-err" role="alert">
          {checkError}
        </p>
      )}
    </section>
  );
}

/**
 * Renders the Tools section: the number of tools at the right of the
 * heading, a note, and one row for each tool with its name in mono and its
 * description. With none, a line says they show once the check is done.
 */
export function ToolsSection({ view }: { readonly view: McpServerView }): JSX.Element {
  const { tools } = view.server;
  return (
    <section className="set-sec">
      <h2>
        Tools
        <small>{tools.length}</small>
      </h2>
      <p>
        What the server offered when it was last checked. Agents get all of them: a tool cannot be
        switched off here.
      </p>
      <div>
        {tools.map((tool) => (
          <div key={tool.name} className="mcp-tool">
            <code>{tool.name}</code>
            <span>{tool.description}</span>
          </div>
        ))}
        {tools.length === 0 && (
          <div className="mcp-tool mcp-tool--none">The tools show here once the check is done.</div>
        )}
      </div>
    </section>
  );
}
