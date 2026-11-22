/**
 * The records the MCP specimens' fake controller answers with, as the
 * controller would return them (spec 17 §Settings, MCP servers, and the
 * composer's `+` menu). One world serves every scene:
 *
 * - **Connections and plugins** are Settings > Connections' (see
 *   settings-connections-fixture.ts). Six of their plugins offer an MCP
 *   server: GitHub, Grafana, Linear, PostHog, Sentry and Stripe, and Sentry
 *   has two Connections, `webshop-prod` and `hobby`.
 * - **The servers** are one on each Connection except PostHog's, in each
 *   state a scene needs: two Sentry servers that share the name `sentry`
 *   (ready), GitHub (ready), Linear (needs sign-in), Grafana (switched off),
 *   and Stripe (checking, never listed yet). PostHog's Connection has no
 *   server record, which Settings draws as "off" with no page.
 * - **The projects** are the sidebar specimen's three, naming servers:
 *   webshop names Sentry (work), GitHub and Linear, payments-api names Sentry
 *   (work) and GitHub, and ops names Sentry (hobby).
 * - **The default list** of a thread with no project is GitHub and Stripe.
 *
 * The scenes are `settings-mcp-servers.tsx` (the list, a server's page, the
 * picker), `settings-connections.tsx` (the notes), `thread-mcp.tsx` and
 * `draft-mcp.tsx` (the `+` menu), and the thread's lines.
 */
import type { McpServer, McpServerTool, Project, Session } from "@hercule/contract";
import { buildServer } from "@hercule/client-core/mcp-servers/testing";
import {
  CONNECTIONS,
  CONNECTIONS_PLUGINS,
  CONNECTIONS_SIDEBAR_RECORDS,
} from "./settings-connections-fixture";
import { PROVIDER_PLUGINS } from "./settings-providers-fixture";
import { DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT } from "./draft-fixture";
import type { DraftScreenRecords, SidebarRecords, ThreadScreenRecords } from "./shell-page";
import { SPECIMEN_NOW } from "./sidebar-fixture";
import { buildTranscript, FIX_SESSION, FIX_STEPS, THREAD_PAGE_RECORDS } from "./thread-fixture";

/**
 * What the MCP screens read besides the shell's lists, which hold the
 * projects (each with its servers), the Connections and the plugins: the
 * servers, and the setting that lists the servers of a thread with no project.
 */
export interface McpServersRecords {
  /** Every MCP Server, sorted by name, as `mcpServer.query` returns them. */
  readonly servers: ReadonlyArray<McpServer>;
  /** The setting `thread.mcpServerIds`. */
  readonly defaultServerIds: ReadonlyArray<string>;
}

/** The time `minutes` before the specimen's clock, as the API spells a time. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

const SENTRY_TOOLS: readonly McpServerTool[] = [
  { name: "whoami", description: "Who the Connection is signed in as." },
  { name: "find_organizations", description: "List the organizations the account can see." },
  { name: "find_projects", description: "List the projects of an organization." },
  { name: "find_releases", description: "List the releases of a project." },
  {
    name: "search_issues",
    description: "Search issues in plain words, such as 'unresolved in checkout this week'.",
  },
  { name: "search_events", description: "Search errors, logs and spans, and count them." },
  {
    name: "get_issue_details",
    description: "Read one issue with its latest event and stack trace.",
  },
  { name: "get_trace_details", description: "Read one trace and its spans." },
  { name: "get_event_attachment", description: "Download an attachment of an event." },
  { name: "update_issue", description: "Resolve, ignore or assign an issue." },
  { name: "analyze_issue_with_seer", description: "Ask Seer for the root cause of an issue." },
  { name: "search_docs", description: "Search Sentry's documentation." },
  { name: "get_doc", description: "Read one page of Sentry's documentation." },
];

const LINEAR_TOOLS: readonly McpServerTool[] = [
  { name: "list_issues", description: "List issues, filtered by team, state, assignee or label." },
  { name: "get_issue", description: "Read one issue with its comments." },
  { name: "create_issue", description: "Create an issue in a team." },
  { name: "update_issue", description: "Change an issue's state, assignee, labels or text." },
  { name: "create_comment", description: "Comment on an issue." },
  { name: "list_projects", description: "List projects." },
  { name: "get_project", description: "Read one project and its milestones." },
  { name: "list_cycles", description: "List the cycles of a team." },
  { name: "list_teams", description: "List teams." },
  { name: "list_users", description: "List the people of the workspace." },
  { name: "search_documentation", description: "Search Linear's documentation." },
];

const GITHUB_TOOLS: readonly McpServerTool[] = [
  { name: "search_code", description: "Search code across repositories." },
  { name: "get_file_contents", description: "Read a file or a folder of a repository." },
  { name: "list_pull_requests", description: "List the pull requests of a repository." },
  {
    name: "pull_request_read",
    description: "Read a pull request: its diff, reviews, checks and comments.",
  },
  { name: "create_pull_request", description: "Open a pull request." },
  { name: "list_issues", description: "List the issues of a repository." },
  { name: "issue_read", description: "Read one issue with its comments." },
  { name: "add_issue_comment", description: "Comment on an issue or a pull request." },
  { name: "list_workflow_runs", description: "List the runs of an Actions workflow." },
  { name: "get_job_logs", description: "Read the logs of a failed job." },
];

const GRAFANA_TOOLS: readonly McpServerTool[] = [
  { name: "search_dashboards", description: "Search dashboards by title or tag." },
  { name: "get_dashboard", description: "Read one dashboard with its panels." },
  { name: "query_prometheus", description: "Run a PromQL query." },
  { name: "list_alert_rules", description: "List the alert rules and their state." },
];

const SENTRY_WORK_ID = "s-sentry-work";
const SENTRY_HOBBY_ID = "s-sentry-hobby";
const GITHUB_ID = "s-github";
const LINEAR_ID = "s-linear";
const GRAFANA_ID = "s-grafana";
const STRIPE_ID = "s-stripe";

/** The servers, in the order the controller lists them (by name, then by when they were made). */
export const MCP_SERVERS: ReadonlyArray<McpServer> = [
  buildServer(GRAFANA_ID, "grafana", "c-grafana", {
    enabled: false,
    tools: GRAFANA_TOOLS,
    checkedAt: minutesAgo(3 * 24 * 60),
    createdAt: minutesAgo(10 * 24 * 60),
    updatedAt: minutesAgo(3 * 24 * 60),
  }),
  buildServer(GITHUB_ID, "github", "c-github", {
    tools: GITHUB_TOOLS,
    checkedAt: minutesAgo(5),
    createdAt: minutesAgo(10 * 24 * 60),
  }),
  buildServer(LINEAR_ID, "linear", "c-linear", {
    status: "needs-sign-in",
    statusDetail: "Linear refused the saved sign-in at 09:12 (401, token revoked).",
    tools: LINEAR_TOOLS,
    checkedAt: minutesAgo(60),
    createdAt: minutesAgo(10 * 24 * 60),
  }),
  buildServer(SENTRY_WORK_ID, "sentry", "c-sentry", {
    tools: SENTRY_TOOLS,
    checkedAt: minutesAgo(3),
    createdAt: minutesAgo(10 * 24 * 60),
  }),
  buildServer(SENTRY_HOBBY_ID, "sentry", "c-sentry-hobby", {
    tools: SENTRY_TOOLS,
    checkedAt: minutesAgo(3),
    createdAt: minutesAgo(5 * 24 * 60),
  }),
  buildServer(STRIPE_ID, "stripe", "c-stripe", {
    status: "checking",
    tools: [],
    checkedAt: null,
    createdAt: minutesAgo(1),
  }),
];

/**
 * The sidebar's three projects, naming the servers their threads start with.
 * The sidebar draws the tile of each, tinted by its place in the list.
 */
export const MCP_PROJECTS: ReadonlyArray<Project> = THREAD_PAGE_RECORDS.projects.map((project) => ({
  ...project,
  mcpServerIds:
    project.name === "webshop"
      ? [SENTRY_WORK_ID, GITHUB_ID, LINEAR_ID]
      : project.name === "payments-api"
        ? [SENTRY_WORK_ID, GITHUB_ID]
        : [SENTRY_HOBBY_ID],
}));

/** What the MCP screens read: the servers, and the default list of a thread with no project. */
export const MCP_RECORDS: McpServersRecords = {
  servers: MCP_SERVERS,
  defaultServerIds: [GITHUB_ID, STRIPE_ID],
};

/** The records of one scene's servers with `changes` applied to the servers they name by id. */
export const changeServers = (
  changes: Readonly<Record<string, Partial<McpServer>>>,
): McpServersRecords => ({
  ...MCP_RECORDS,
  servers: MCP_SERVERS.map((server) => ({ ...server, ...changes[server.id] })),
});

/**
 * The shell's lists for the Settings scenes: Settings > Connections'
 * sidebar, with the Connections and plugins of the world and the projects
 * that name servers.
 */
export const MCP_SETTINGS_PAGE_RECORDS: SidebarRecords = {
  ...CONNECTIONS_SIDEBAR_RECORDS,
  projects: MCP_PROJECTS,
  connections: CONNECTIONS,
  plugins: CONNECTIONS_PLUGINS,
};

/** The id of the server a page scene opens when the address names none: the hobby Sentry server. */
export const MCP_HOBBY_SERVER_ID = SENTRY_HOBBY_ID;

/** The id of the Linear server, which needs sign-in. */
export const MCP_LINEAR_SERVER_ID = LINEAR_ID;

/** The thread's servers, each as the session's list holds one. `leftOut` marks a server the last start left out. */
const buildSessionServers = (
  ids: ReadonlyArray<string>,
  servers: ReadonlyArray<McpServer>,
  leftOut: Readonly<Record<string, NonNullable<Session["mcpServers"][number]["leftOut"]>>> = {},
): Session["mcpServers"] =>
  ids.map((id) => ({
    mcpServerId: id,
    name: servers.find((server) => server.id === id)?.name ?? id,
    leftOut: leftOut[id] ?? null,
  }));

/** The shell's lists for a thread scene: the thread page's, with the world's Connections, plugins and projects. */
const buildThreadPageRecords = (session: Session): SidebarRecords => ({
  ...THREAD_PAGE_RECORDS,
  threads: THREAD_PAGE_RECORDS.threads.map((thread) =>
    thread.id === session.id ? session : thread,
  ),
  projects: MCP_PROJECTS,
  connections: CONNECTIONS,
  plugins: CONNECTIONS_PLUGINS,
});

/**
 * The Fix thread in webshop, finished its turn and waiting for the user, that
 * started with webshop's three servers: Sentry (work), GitHub and Linear,
 * which needs sign-in, so the `+` carries the red dot. The menu offers Sentry's
 * second account, and Stripe, and has Grafana behind "1 more server…".
 */
export const MCP_THREAD: {
  readonly records: SidebarRecords;
  readonly thread: ThreadScreenRecords;
} = (() => {
  const session: Session = {
    ...FIX_SESSION,
    status: "idle",
    openRequests: [],
    mcpServers: buildSessionServers([SENTRY_WORK_ID, GITHUB_ID, LINEAR_ID], MCP_SERVERS),
  };
  return {
    records: buildThreadPageRecords(session),
    thread: {
      session,
      transcript: buildTranscript(FIX_STEPS.filter(([, event]) => event._tag !== "request.opened")),
      queuedInputs: [],
    },
  };
})();

/**
 * The Fix thread whose transcript holds the two lines about MCP servers:
 * Linear left out at the start because it needed sign-in, with a Reconnect
 * button, and a call to Grafana that the controller refused because Grafana
 * could not be reached, with an Open server button. Grafana is switched on
 * and unreachable in this scene's world (`MCP_THREAD_LINES.servers`).
 */
export const MCP_THREAD_LINES: {
  readonly records: SidebarRecords;
  readonly thread: ThreadScreenRecords;
  readonly servers: McpServersRecords;
} = (() => {
  const servers = changeServers({
    [GRAFANA_ID]: {
      enabled: true,
      status: "unreachable",
      statusDetail: "mcp.grafana.example did not answer within 10 seconds, last tried at 09:35.",
    },
  });
  const session: Session = {
    ...FIX_SESSION,
    status: "idle",
    openRequests: [],
    mcpServers: buildSessionServers(
      [SENTRY_WORK_ID, GITHUB_ID, LINEAR_ID, GRAFANA_ID],
      servers.servers,
      { [LINEAR_ID]: "needs-sign-in" },
    ),
  };
  const turn = { turnId: "turn-1" } as const;
  const steps = FIX_STEPS.filter(([, event]) => event._tag !== "request.opened").flatMap((step) => {
    const [seconds] = step;
    if (seconds === 5) {
      return [
        [
          2,
          {
            _tag: "runtime.warning" as const,
            ...turn,
            message: "MCP servers not available in this session: linear (needs sign-in)",
            mcpServers: [{ mcpServerId: LINEAR_ID, reason: "needs-sign-in" as const }],
          },
        ],
        step,
      ] as const;
    }
    if (seconds === 210) {
      return [
        [
          200,
          {
            _tag: "runtime.warning" as const,
            ...turn,
            message: "A tool call was refused. grafana could not be reached. Try again later.",
            mcpServers: [{ mcpServerId: GRAFANA_ID, reason: "unreachable" as const }],
          },
        ],
        step,
      ] as const;
    }
    return [step];
  });
  return {
    records: buildThreadPageRecords(session),
    thread: { session, transcript: buildTranscript(steps), queuedInputs: [] },
    servers,
  };
})();

/**
 * The Draft Thread in webshop, which starts with webshop's three servers,
 * and the shell's lists around it, with the world's Connections, plugins and
 * projects.
 */
export const MCP_DRAFT: {
  readonly records: SidebarRecords;
  readonly draft: DraftScreenRecords;
} = {
  records: {
    ...DRAFT_PAGE_RECORDS,
    projects: MCP_PROJECTS,
    connections: CONNECTIONS,
    plugins: [...PROVIDER_PLUGINS, ...CONNECTIONS_PLUGINS],
  },
  draft: { ...WEBSHOP_DRAFT, connections: CONNECTIONS },
};
