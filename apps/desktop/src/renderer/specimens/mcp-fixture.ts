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

const DOCS_URL_ID = "s-docs";
const NOTION_URL_ID = "s-notion";
const RUNBOOKS_ID = "s-runbooks";
const POSTHOG_DOCS_ID = "s-posthogdocs";
const WIKI_ID = "s-wiki";
const ATLAS_ID = "s-atlas";

/**
 * Returns a server added by URL, named `name`, at the address `url`, that
 * holds `signIn` and was told the server accepts `signInOffered`. It is on a
 * fixture Connection id no row reads, because a server added by URL has none.
 */
const buildUrlServer = (
  id: string,
  name: string,
  url: string,
  signIn: "none" | "token" | "oauth",
  signInOffered: "oauth" | "token" | null,
  overrides: Partial<McpServer> = {},
): McpServer =>
  buildServer(id, name, "c-none", {
    source: { kind: "url", url, signIn, signInOffered },
    ...overrides,
  });

/**
 * The servers added by URL: Docs (ready, no sign-in), Notion (a pasted token
 * the server refused, so it needs sign-in), Runbooks (unreachable), and a
 * server on PostHog's address, which the PostHog Connection's row offers
 * Replace for. PostHog's Connection has no server of its own in this world.
 */
export const MCP_URL_SERVERS: ReadonlyArray<McpServer> = [
  buildUrlServer(DOCS_URL_ID, "docs", "https://mcp.docs.example/mcp", "none", null, {
    tools: GRAFANA_TOOLS,
    checkedAt: minutesAgo(8),
    createdAt: minutesAgo(4 * 24 * 60),
  }),
  buildUrlServer(NOTION_URL_ID, "notion", "https://mcp.notion.example/mcp", "token", "token", {
    status: "needs-sign-in",
    statusDetail: "mcp.notion.example refused the saved token at 09:12 (401, token revoked).",
    tools: LINEAR_TOOLS.slice(0, 6),
    checkedAt: minutesAgo(70),
    createdAt: minutesAgo(6 * 24 * 60),
  }),
  buildUrlServer(RUNBOOKS_ID, "runbooks", "https://runbooks.acme.example/mcp", "none", null, {
    status: "unreachable",
    statusDetail: "runbooks.acme.example did not answer within 10 seconds, last tried at 09:35.",
    tools: GRAFANA_TOOLS.slice(0, 3),
    checkedAt: minutesAgo(180),
    createdAt: minutesAgo(2 * 24 * 60),
  }),
  buildUrlServer(POSTHOG_DOCS_ID, "posthogdocs", "https://mcp.posthog.com/mcp", "token", "token", {
    tools: GITHUB_TOOLS.slice(0, 5),
    checkedAt: minutesAgo(12),
    enabled: false,
  }),
];

/** The server the Add by URL dialog creates in the scenes that add one: it asks for a token. */
export const MCP_NEW_URL_SERVER: McpServer = buildUrlServer(
  WIKI_ID,
  "wiki",
  "https://mcp.wiki.example/mcp",
  "none",
  "token",
  {
    status: "needs-sign-in",
    statusDetail: "mcp.wiki.example answered 401.",
    tools: [],
    checkedAt: null,
    createdAt: minutesAgo(0),
  },
);

/**
 * A server added by URL that signs in through the browser and needs sign-in:
 * the scenes of the sign-in dialog open its page.
 */
export const MCP_OAUTH_SERVER: McpServer = buildUrlServer(
  ATLAS_ID,
  "atlas",
  "https://mcp.atlas.example/mcp",
  "none",
  "oauth",
  {
    status: "needs-sign-in",
    statusDetail: "mcp.atlas.example answered 401.",
    tools: [],
    checkedAt: minutesAgo(30),
    createdAt: minutesAgo(3 * 24 * 60),
  },
);

/** The server of `MCP_OAUTH_SERVER` as it is after the sign-in through the browser finished. */
export const MCP_SIGNED_IN_OAUTH_SERVER: McpServer = buildUrlServer(
  ATLAS_ID,
  "atlas",
  "https://mcp.atlas.example/mcp",
  "oauth",
  "oauth",
  { tools: LINEAR_TOOLS.slice(0, 4), checkedAt: minutesAgo(0), createdAt: minutesAgo(3 * 24 * 60) },
);

/**
 * The servers of the scenes that draw servers added by URL: the world's
 * servers and `MCP_URL_SERVERS`, and the default list. Other scenes keep
 * `MCP_RECORDS`, so their pickers and menus stay as they were.
 */
export const MCP_URL_RECORDS: McpServersRecords = {
  servers: [...MCP_SERVERS, ...MCP_URL_SERVERS].toSorted((a, b) => a.name.localeCompare(b.name)),
  defaultServerIds: [GITHUB_ID, STRIPE_ID],
};

/** The records of the sign-in dialog's scenes: those of `MCP_URL_RECORDS` and the server that signs in through the browser. */
export const MCP_OAUTH_RECORDS: McpServersRecords = {
  servers: [...MCP_URL_RECORDS.servers, MCP_OAUTH_SERVER].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  ),
  defaultServerIds: MCP_URL_RECORDS.defaultServerIds,
};

/**
 * Returns the records of `MCP_URL_RECORDS` with `extra` servers added, sorted
 * by name as the controller lists them. Each scene that needs one more server
 * adds it here, so the scenes that exist keep their records.
 */
const addUrlServers = (...extra: ReadonlyArray<McpServer>): McpServersRecords => ({
  ...MCP_URL_RECORDS,
  servers: [...MCP_URL_RECORDS.servers, ...extra].toSorted((a, b) => a.name.localeCompare(b.name)),
});

/** A ready server added by URL that holds a pasted token: its page offers "Replace token…". */
const LEDGER_SERVER = buildUrlServer(
  "s-ledger",
  "ledger",
  "https://mcp.ledger.example/mcp",
  "token",
  "token",
  { tools: GITHUB_TOOLS.slice(0, 5), checkedAt: minutesAgo(6), createdAt: minutesAgo(8 * 24 * 60) },
);

/** A ready server added by URL that holds a sign-in through the browser: its page offers "Sign in again…". */
const RELAY_SERVER = buildUrlServer(
  "s-relay",
  "relay",
  "https://mcp.relay.example/mcp",
  "oauth",
  "oauth",
  { tools: LINEAR_TOOLS.slice(0, 4), checkedAt: minutesAgo(9), createdAt: minutesAgo(7 * 24 * 60) },
);

/**
 * A server added by URL whose address is far longer than a row: the list and
 * the page show it whole, wrapped, and the tool count after it stays in view.
 */
const ARCHIVE_SERVER = buildUrlServer(
  "s-archive",
  "archive",
  "https://mcp.knowledge-archive.internal.acme-corporation.example/organizations/acme-corporation/workspaces/engineering-platform/mcp",
  "none",
  null,
  { tools: GRAFANA_TOOLS, checkedAt: minutesAgo(14), createdAt: minutesAgo(9 * 24 * 60) },
);

/** A second server added by URL on PostHog's address, so Replace has two to choose from. */
const POSTHOG_EU_SERVER = buildUrlServer(
  "s-posthogeu",
  "posthogeu",
  "https://mcp.posthog.com/mcp?region=eu",
  "token",
  "token",
  {
    tools: GITHUB_TOOLS.slice(0, 3),
    checkedAt: minutesAgo(30),
    createdAt: minutesAgo(2 * 24 * 60),
  },
);

/** The server the Add by URL dialog creates in the scene that ends on ready: it answers with its tools. */
export const MCP_READY_NEW_URL_SERVER: McpServer = buildUrlServer(
  "s-knowledge",
  "knowledge",
  "https://mcp.knowledge.example/mcp",
  "none",
  null,
  { tools: GRAFANA_TOOLS, checkedAt: minutesAgo(0), createdAt: minutesAgo(0) },
);

/** The records of the scenes that draw the page of a ready server added by URL. */
export const MCP_READY_URL_RECORDS: McpServersRecords = addUrlServers(LEDGER_SERVER, RELAY_SERVER);

/** The records of the scene that draws a very long address in the list. */
export const MCP_LONG_ADDRESS_RECORDS: McpServersRecords = addUrlServers(ARCHIVE_SERVER);

/** The records of the scene whose Replace dialog has two servers to choose from. */
export const MCP_REPLACE_SEVERAL_RECORDS: McpServersRecords = addUrlServers(POSTHOG_EU_SERVER);

/** The ids of the ready servers whose pages offer "Replace token…" and "Sign in again…". */
export const MCP_LEDGER_SERVER_ID = LEDGER_SERVER.id;
export const MCP_RELAY_SERVER_ID = RELAY_SERVER.id;

/** The id of the server whose address is far longer than a row. */
export const MCP_ARCHIVE_SERVER_ID = ARCHIVE_SERVER.id;

/** The server on PostHog's address that Replace moves onto the PostHog Connection. */
export const MCP_POSTHOG_URL_SERVER: McpServer = MCP_URL_SERVERS.find(
  (server) => server.id === POSTHOG_DOCS_ID,
)!;

/** The id of the server that signs in through the browser. */
export const MCP_ATLAS_SERVER_ID = ATLAS_ID;

/** The id of the Notion server, which needs sign-in, and of the Docs server, which the duplicate refusal points at. */
export const MCP_NOTION_SERVER_ID = NOTION_URL_ID;
export const MCP_DOCS_SERVER_ID = DOCS_URL_ID;

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

/** The id of the Stripe server, which is checking for the first time. */
export const MCP_STRIPE_SERVER_ID = STRIPE_ID;

/** The id of the Grafana server, which is switched off. */
export const MCP_GRAFANA_SERVER_ID = GRAFANA_ID;

/** The id of the GitHub server. */
export const MCP_GITHUB_SERVER_ID = GITHUB_ID;

/** The servers with Grafana switched on and unreachable, as the controller records a check that got no answer. */
export const MCP_RECORDS_GRAFANA_UNREACHABLE: McpServersRecords = changeServers({
  [GRAFANA_ID]: {
    enabled: true,
    status: "unreachable",
    statusDetail: "mcp.grafana.example did not answer within 10 seconds, last tried at 09:35.",
  },
});

/** The servers with GitHub's refused by the server, as a check that was answered with an error records it. */
export const MCP_RECORDS_GITHUB_ERROR: McpServersRecords = changeServers({
  [GITHUB_ID]: {
    status: "error",
    statusDetail: "GitHub's MCP server answered 500 to the tools request at 09:31.",
  },
});

/**
 * The shell's lists and the servers of a world where no Connection has a
 * plugin that offers an MCP server and no server exists: the list has no row
 * to draw.
 */
export const MCP_NO_OFFERS: {
  readonly records: SidebarRecords;
  readonly mcp: McpServersRecords;
} = {
  records: {
    ...MCP_SETTINGS_PAGE_RECORDS,
    projects: MCP_PROJECTS.map((project) => ({ ...project, mcpServerIds: [] })),
    plugins: CONNECTIONS_PLUGINS.map((plugin) => ({
      ...plugin,
      contributions: plugin.contributions.filter(
        (contribution) => contribution.extensionPoint !== "mcp-server",
      ),
    })),
  },
  mcp: { servers: [], defaultServerIds: [] },
};

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
  const servers = MCP_RECORDS_GRAFANA_UNREACHABLE;
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
