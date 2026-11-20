/**
 * PROTOTYPE, throwaway. The invented world of the MCP prototype: Connections,
 * MCP Servers, the projects that name them, and the default list of a thread
 * with no project. Everything lives in memory and is lost on reload.
 */
import { useSyncExternalStore } from "react";

/** The five states of an MCP Server (architecture page, section 7.1). */
export type ServerStatus = "checking" | "ready" | "needs-sign-in" | "unreachable" | "disabled";

export const SERVER_STATUSES: readonly ServerStatus[] = [
  "ready",
  "checking",
  "needs-sign-in",
  "unreachable",
  "disabled",
];

export interface Tool {
  readonly name: string;
  readonly description: string;
}

/** How a server the user added by URL signs in. */
export type UrlSignIn = "none" | "token" | "oauth";

export type ServerSource =
  | { readonly kind: "plugin"; readonly pluginId: string; readonly connectionId: string }
  | {
      readonly kind: "user";
      readonly url: string;
      readonly signIn: UrlSignIn;
      /** Who the sign-in is, as the server names it, when it has one. */
      readonly account: string | null;
    };

export interface Server {
  readonly id: string;
  /** What sessions see: tools are `mcp__<name>__<tool>`. */
  readonly name: string;
  readonly source: ServerSource;
  readonly status: ServerStatus;
  /** Why the server is not ready, in the controller's words. */
  readonly statusDetail: string | null;
  readonly tools: readonly Tool[];
  /** When the tools were last listed, as the page shows it. */
  readonly checkedAt: string;
}

export interface Conn {
  readonly id: string;
  readonly pluginId: string;
  readonly typeName: string;
  readonly label: string;
  readonly account: string;
  /** The address of the MCP server the Connection's plugin offers, or null when it offers none. */
  readonly offeredOrigin: string | null;
  readonly failing: string | null;
  readonly events: number;
}

export interface ProjectEntry {
  readonly id: string;
  readonly name: string;
  /** The tint of the project's tile in the sidebar. */
  readonly tint: "webshop" | "payments" | "ops";
  readonly serverIds: readonly string[];
}

export interface World {
  readonly servers: readonly Server[];
  readonly connections: readonly Conn[];
  readonly projects: readonly ProjectEntry[];
  /** The servers a thread with no project gets, when Settings keeps a default list. */
  readonly defaultServerIds: readonly string[];
}

const SENTRY_TOOLS: readonly Tool[] = [
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

const LINEAR_TOOLS: readonly Tool[] = [
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

const GITHUB_TOOLS: readonly Tool[] = [
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

const NOTION_TOOLS: readonly Tool[] = [
  { name: "search", description: "Search pages and databases." },
  { name: "fetch", description: "Read a page or a database by its address." },
  { name: "create-pages", description: "Create one or more pages." },
  { name: "update-page", description: "Change a page's properties or content." },
  { name: "create-comment", description: "Comment on a page." },
  { name: "get-users", description: "List the people of the workspace." },
];

const CONTEXT7_TOOLS: readonly Tool[] = [
  { name: "resolve-library-id", description: "Find a library by its name." },
  { name: "get-library-docs", description: "Read the current documentation of a library." },
];

const DOCS_TOOLS: readonly Tool[] = [
  { name: "search_runbooks", description: "Search the ops runbooks." },
  { name: "read_runbook", description: "Read one runbook." },
  { name: "list_services", description: "List the services and who owns them." },
];

/** The tools a plugin's server lists, by the plugin's id. */
export const PLUGIN_TOOLS: Readonly<Record<string, readonly Tool[]>> = {
  sentry: SENTRY_TOOLS,
  linear: LINEAR_TOOLS,
  github: GITHUB_TOOLS,
};

/** The address each plugin's server is at. */
export const PLUGIN_ORIGINS: Readonly<Record<string, string>> = {
  sentry: "https://mcp.sentry.dev",
  linear: "https://mcp.linear.app",
  github: "https://api.githubcopilot.com",
};

const CONNECTIONS: readonly Conn[] = [
  {
    id: "c-sentry-work",
    pluginId: "sentry",
    typeName: "Sentry",
    label: "webshop-prod",
    account: "Acme · rogier",
    offeredOrigin: PLUGIN_ORIGINS.sentry!,
    failing: null,
    events: 1406,
  },
  {
    id: "c-sentry-hobby",
    pluginId: "sentry",
    typeName: "Sentry",
    label: "hobby",
    account: "birdhouse · rogier",
    offeredOrigin: PLUGIN_ORIGINS.sentry!,
    failing: null,
    events: 12,
  },
  {
    id: "c-github",
    pluginId: "github",
    typeName: "GitHub",
    label: "rogier",
    account: "rogier-acme",
    offeredOrigin: PLUGIN_ORIGINS.github!,
    failing: null,
    events: 312,
  },
  {
    id: "c-linear",
    pluginId: "linear",
    typeName: "Linear",
    label: "acme",
    account: "Acme · rogier@acme.example",
    offeredOrigin: PLUGIN_ORIGINS.linear!,
    failing: null,
    events: 147,
  },
  {
    id: "c-stripe",
    pluginId: "stripe",
    typeName: "Stripe",
    label: "live",
    account: "Acme Inc.",
    offeredOrigin: null,
    failing: null,
    events: 209,
  },
  {
    id: "c-intercom",
    pluginId: "intercom",
    typeName: "Intercom",
    label: "support",
    account: "Acme support",
    offeredOrigin: null,
    failing: "reconnecting since 09:12",
    events: 61,
  },
  {
    id: "c-grafana",
    pluginId: "grafana",
    typeName: "Grafana",
    label: "ops",
    account: "acme.grafana.net",
    offeredOrigin: null,
    failing: null,
    events: 44,
  },
];

const SERVERS: readonly Server[] = [
  {
    id: "s-sentry-work",
    name: "sentry",
    source: { kind: "plugin", pluginId: "sentry", connectionId: "c-sentry-work" },
    status: "ready",
    statusDetail: null,
    tools: SENTRY_TOOLS,
    checkedAt: "09:38",
  },
  {
    id: "s-sentry-hobby",
    name: "sentry",
    source: { kind: "plugin", pluginId: "sentry", connectionId: "c-sentry-hobby" },
    status: "ready",
    statusDetail: null,
    tools: SENTRY_TOOLS,
    checkedAt: "09:38",
  },
  {
    id: "s-github",
    name: "github",
    source: { kind: "plugin", pluginId: "github", connectionId: "c-github" },
    status: "ready",
    statusDetail: null,
    tools: GITHUB_TOOLS,
    checkedAt: "09:36",
  },
  {
    id: "s-linear",
    name: "linear",
    source: {
      kind: "user",
      url: "https://mcp.linear.app/mcp",
      signIn: "oauth",
      account: "rogier@acme.example",
    },
    status: "needs-sign-in",
    statusDetail: "mcp.linear.app refused the saved sign-in at 09:12 (401, token revoked).",
    tools: LINEAR_TOOLS,
    checkedAt: "08:41",
  },
  {
    id: "s-notion",
    name: "notion",
    source: {
      kind: "user",
      url: "https://mcp.notion.com/mcp",
      signIn: "oauth",
      account: "rogier@acme.example",
    },
    status: "checking",
    statusDetail: null,
    tools: NOTION_TOOLS,
    checkedAt: "09:30",
  },
  {
    id: "s-context7",
    name: "context7",
    source: { kind: "user", url: "https://mcp.context7.com/mcp", signIn: "none", account: null },
    status: "unreachable",
    statusDetail: "mcp.context7.com did not answer within 10 seconds, last tried at 09:35.",
    tools: CONTEXT7_TOOLS,
    checkedAt: "07:02",
  },
  {
    id: "s-runbooks",
    name: "runbooks",
    source: {
      kind: "user",
      url: "https://runbooks.acme.example/mcp",
      signIn: "token",
      account: null,
    },
    status: "disabled",
    statusDetail: null,
    tools: DOCS_TOOLS,
    checkedAt: "26 Sep",
  },
];

const PROJECTS: readonly ProjectEntry[] = [
  {
    id: "p-webshop",
    name: "webshop",
    tint: "webshop",
    serverIds: ["s-sentry-work", "s-github", "s-linear", "s-notion"],
  },
  {
    id: "p-payments-api",
    name: "payments-api",
    tint: "payments",
    serverIds: ["s-sentry-work", "s-github", "s-context7"],
  },
  { id: "p-ops", name: "ops", tint: "ops", serverIds: ["s-sentry-hobby"] },
];

const FIRST_WORLD: World = {
  servers: SERVERS,
  connections: CONNECTIONS,
  projects: PROJECTS,
  defaultServerIds: ["s-github", "s-context7"],
};

/** Builds a ready server added by URL, for the large world. */
const buildUrlServer = (
  name: string,
  host: string,
  signIn: UrlSignIn,
  tools: readonly Tool[],
): Server => ({
  id: `s-${name}`,
  name,
  source: {
    kind: "user",
    url: `https://${host}/mcp`,
    signIn,
    account: signIn === "oauth" ? "rogier@acme.example" : null,
  },
  status: "ready",
  statusDetail: null,
  tools,
  checkedAt: "09:30",
});

/**
 * The large world: 15 servers and 10 projects, to see whether a drawing
 * still works at that size (`?size=large`).
 */
const LARGE_WORLD: World = {
  connections: CONNECTIONS,
  servers: [
    ...SERVERS,
    buildUrlServer("figma", "mcp.figma.com", "oauth", NOTION_TOOLS.slice(0, 4)),
    buildUrlServer("atlassian", "mcp.atlassian.com", "oauth", LINEAR_TOOLS),
    buildUrlServer("vercel", "mcp.vercel.com", "oauth", GITHUB_TOOLS.slice(0, 7)),
    buildUrlServer("cloudflare", "docs.mcp.cloudflare.com", "none", CONTEXT7_TOOLS),
    buildUrlServer("stripe", "mcp.stripe.com", "oauth", LINEAR_TOOLS.slice(0, 8)),
    buildUrlServer("posthog", "mcp.posthog.com", "token", SENTRY_TOOLS.slice(0, 9)),
    buildUrlServer("grafana", "mcp.acme.grafana.net", "token", DOCS_TOOLS),
    buildUrlServer("deepwiki", "mcp.deepwiki.com", "none", CONTEXT7_TOOLS),
  ],
  projects: [
    {
      ...PROJECTS[0]!,
      serverIds: [...PROJECTS[0]!.serverIds, "s-figma", "s-stripe", "s-posthog", "s-vercel"],
    },
    { ...PROJECTS[1]!, serverIds: [...PROJECTS[1]!.serverIds, "s-stripe", "s-atlassian"] },
    { ...PROJECTS[2]!, serverIds: [...PROJECTS[2]!.serverIds, "s-grafana", "s-cloudflare"] },
    {
      id: "p-storefront-ios",
      name: "storefront-ios",
      tint: "webshop",
      serverIds: ["s-sentry-work", "s-github", "s-figma", "s-linear"],
    },
    {
      id: "p-design-system",
      name: "design-system",
      tint: "payments",
      serverIds: ["s-github", "s-figma", "s-notion"],
    },
    {
      id: "p-data-pipeline",
      name: "data-pipeline",
      tint: "ops",
      serverIds: ["s-sentry-work", "s-github", "s-grafana", "s-posthog"],
    },
    {
      id: "p-docs-site",
      name: "docs-site",
      tint: "webshop",
      serverIds: ["s-github", "s-notion", "s-vercel", "s-deepwiki"],
    },
    {
      id: "p-infra",
      name: "infra",
      tint: "payments",
      serverIds: ["s-sentry-work", "s-github", "s-grafana", "s-cloudflare", "s-atlassian"],
    },
    {
      id: "p-birdhouse",
      name: "birdhouse",
      tint: "ops",
      serverIds: ["s-sentry-hobby", "s-context7"],
    },
    { id: "p-playground", name: "playground", tint: "webshop", serverIds: [] },
  ],
  defaultServerIds: ["s-github", "s-context7", "s-deepwiki"],
};

let world: World =
  new URLSearchParams(location.search).get("size") === "large" ? LARGE_WORLD : FIRST_WORLD;
const listeners = new Set<() => void>();

/** Replaces the world with `change(world)` and redraws every reader. */
export function changeWorld(change: (current: World) => World): void {
  world = change(world);
  for (const listener of listeners) listener();
}

export const readWorld = (): World => world;

/** Returns the world, and redraws the component when it changes. */
export function useWorld(): World {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => world,
  );
}

export const findConnection = (w: World, id: string): Conn | undefined =>
  w.connections.find((each) => each.id === id);

/** Returns the Connection a plugin's server is reached with, or undefined for a server added by URL. */
export const findServerConnection = (w: World, server: Server): Conn | undefined =>
  server.source.kind === "plugin" ? findConnection(w, server.source.connectionId) : undefined;

export const describeConnection = (connection: Conn): string =>
  `${connection.typeName} · ${connection.label}`;

/** Returns the server's address without its scheme, as a row shows it. */
export const describeAddress = (server: Server): string => {
  if (server.source.kind === "user") return server.source.url.replace(/^https?:\/\//, "");
  const origin = PLUGIN_ORIGINS[server.source.pluginId] ?? "";
  return `${origin.replace(/^https?:\/\//, "")}/mcp`;
};

/**
 * Returns a server's name as plain text, for a title, a button or a sentence:
 * its name, then the label of its Connection after a dot, such as
 * "sentry · hobby". A server added by URL is its name alone. Two servers can
 * share a name, and the label tells them apart. Where the name can be styled,
 * `ServerName` draws it instead. A server is never written as its Connection
 * ("Sentry · hobby"): that spelling names the Connection.
 */
export const describeServerName = (w: World, server: Server): string => {
  const connection = findServerConnection(w, server);
  return connection === undefined ? server.name : `${server.name} · ${connection.label}`;
};

/** Returns the server's address without path or query, which is how a duplicate is recognised. */
export const readOrigin = (url: string): string | null => {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
};

/** Returns the server a plugin's Connection is switched on as, if any. */
export const findConnectionServer = (w: World, connectionId: string): Server | undefined =>
  w.servers.find(
    (server) => server.source.kind === "plugin" && server.source.connectionId === connectionId,
  );

/** Returns the server the user added by hand at the address a Connection's plugin offers, if any. */
export const findHandAddedTwin = (w: World, connection: Conn): Server | undefined =>
  w.servers.find(
    (server) =>
      server.source.kind === "user" && readOrigin(server.source.url) === connection.offeredOrigin,
  );

/** Returns the projects that name `serverId`. */
export const listServerProjects = (w: World, serverId: string): readonly ProjectEntry[] =>
  w.projects.filter((project) => project.serverIds.includes(serverId));

/**
 * Returns the server a project already names under the same name as `server`,
 * or undefined. One project cannot name two servers with one name: their
 * tools would both be `mcp__<name>__<tool>`.
 */
export const findNameClash = (
  w: World,
  serverIds: readonly string[],
  server: Server,
): Server | undefined =>
  w.servers.find(
    (other) => other.id !== server.id && other.name === server.name && serverIds.includes(other.id),
  );

export function setServer(id: string, change: Partial<Server>): void {
  changeWorld((w) => ({
    ...w,
    servers: w.servers.map((server) => (server.id === id ? { ...server, ...change } : server)),
  }));
}

/**
 * Sets a server's status as the prototype's bar asks, with a detail that fits
 * the server's source.
 */
export function forceStatus(id: string, status: ServerStatus): void {
  const w = readWorld();
  const server = w.servers.find((each) => each.id === id);
  if (server === undefined) return;
  const connection = findServerConnection(w, server);
  const host = describeAddress(server).split("/")[0]!;
  const detail =
    status === "needs-sign-in"
      ? connection !== undefined
        ? `${connection.typeName} asked for a new sign-in at 09:12. The Connection ${describeConnection(connection)} must be reconnected.`
        : server.source.kind === "user" && server.source.signIn === "token"
          ? `${host} refused the saved token at 09:12 (401).`
          : `${host} refused the saved sign-in at 09:12 (401, token revoked).`
      : status === "unreachable"
        ? `${host} did not answer within 10 seconds, last tried at 09:35.`
        : null;
  setServer(id, { status, statusDetail: detail });
}

/** Adds or removes `serverId` on a project's list. Naming a server drops the one that shares its name. */
export function setProjectServer(projectId: string, serverId: string, named: boolean): void {
  changeWorld((w) => {
    const server = w.servers.find((each) => each.id === serverId)!;
    return {
      ...w,
      projects: w.projects.map((project) => {
        if (project.id !== projectId) return project;
        const without = project.serverIds.filter((id) => id !== serverId);
        if (!named) return { ...project, serverIds: without };
        const clash = findNameClash(w, without, server);
        return {
          ...project,
          serverIds: [...without.filter((id) => id !== clash?.id), serverId],
        };
      }),
    };
  });
}

/** Adds or removes `serverId` on the default list, with the same rule for a shared name. */
export function setDefaultServer(serverId: string, named: boolean): void {
  changeWorld((w) => {
    const server = w.servers.find((each) => each.id === serverId)!;
    const without = w.defaultServerIds.filter((id) => id !== serverId);
    if (!named) return { ...w, defaultServerIds: without };
    const clash = findNameClash(w, without, server);
    return { ...w, defaultServerIds: [...without.filter((id) => id !== clash?.id), serverId] };
  });
}

let nextId = 1;

/** Switches on the server a Connection's plugin offers, and returns it. */
export function switchOnConnectionServer(connectionId: string): Server {
  const connection = findConnection(readWorld(), connectionId)!;
  const server: Server = {
    id: `s-new-${String(nextId++)}`,
    name: connection.pluginId,
    source: { kind: "plugin", pluginId: connection.pluginId, connectionId },
    status: "checking",
    statusDetail: null,
    tools: [],
    checkedAt: "now",
  };
  changeWorld((w) => ({ ...w, servers: [...w.servers, server] }));
  finishCheck(server.id, PLUGIN_TOOLS[connection.pluginId] ?? []);
  return server;
}

/**
 * Moves the hand-added server `serverId` to a plugin's Connection: the record
 * keeps its id, its name and the projects that name it.
 */
export function replaceWithConnection(serverId: string, connectionId: string): void {
  const connection = findConnection(readWorld(), connectionId)!;
  setServer(serverId, {
    source: { kind: "plugin", pluginId: connection.pluginId, connectionId },
    status: "checking",
    statusDetail: null,
  });
  finishCheck(serverId, PLUGIN_TOOLS[connection.pluginId] ?? []);
}

/** Adds a server by URL, and returns it. */
export function addUrlServer(
  name: string,
  url: string,
  signIn: UrlSignIn,
  account: string | null,
  tools: readonly Tool[],
): Server {
  const server: Server = {
    id: `s-new-${String(nextId++)}`,
    name,
    source: { kind: "user", url, signIn, account },
    status: "ready",
    statusDetail: null,
    tools,
    checkedAt: "now",
  };
  changeWorld((w) => ({ ...w, servers: [...w.servers, server] }));
  return server;
}

export function deleteServer(id: string): void {
  changeWorld((w) => ({
    ...w,
    servers: w.servers.filter((server) => server.id !== id),
    projects: w.projects.map((project) => ({
      ...project,
      serverIds: project.serverIds.filter((each) => each !== id),
    })),
    defaultServerIds: w.defaultServerIds.filter((each) => each !== id),
  }));
}

/** Shows `checking` for a moment, then `ready` with `tools`, as a check that passed would. */
export function finishCheck(id: string, tools?: readonly Tool[]): void {
  setServer(id, { status: "checking", statusDetail: null });
  setTimeout(() => {
    setServer(id, {
      status: "ready",
      statusDetail: null,
      checkedAt: "now",
      ...(tools === undefined ? {} : { tools }),
    });
  }, 1400);
}

/** The tools a server at `url` lists, for the servers the prototype knows. */
export const guessTools = (url: string): readonly Tool[] => {
  if (url.includes("notion")) return NOTION_TOOLS;
  if (url.includes("context7")) return CONTEXT7_TOOLS;
  if (url.includes("linear")) return LINEAR_TOOLS;
  return DOCS_TOOLS;
};

/**
 * Sets which of the servers named `name` is on the list `ids`: `serverId`, or
 * none of them with null. Returns the new list. A list holds at most one
 * server per name.
 */
export const pickNamedServer = (
  w: World,
  ids: readonly string[],
  name: string,
  serverId: string | null,
): readonly string[] => {
  const sameName = new Set(
    w.servers.filter((server) => server.name === name).map((server) => server.id),
  );
  const without = ids.filter((id) => !sameName.has(id));
  return serverId === null ? without : [...without, serverId];
};

export function setProjectServerIds(projectId: string, serverIds: readonly string[]): void {
  changeWorld((w) => ({
    ...w,
    projects: w.projects.map((project) =>
      project.id === projectId ? { ...project, serverIds } : project,
    ),
  }));
}

export function setDefaultServerIds(serverIds: readonly string[]): void {
  changeWorld((w) => ({ ...w, defaultServerIds: serverIds }));
}
