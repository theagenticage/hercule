/**
 * Test fixtures for the MCP server models: a Sentry plugin and a Linear
 * plugin, three Connections (a work and a hobby Sentry account, and Linear),
 * and the servers on them. A work and a hobby Sentry server share the name
 * `sentry`, which is the case the models exist to handle.
 */
import type { Connection, McpServer, PluginDetail, Project } from "@hercule/contract";
import { buildErrorBody, type Answer, type Handler } from "../api-stub";
import { buildMcpServerViews, type McpServerView } from "./views";

const AT = "2026-11-20T09:00:00.000Z";

/** Returns a plugin that declares the Connection type `<id>/<id>` and the MCP server `<id>/<id>` reached with it. */
export const buildPlugin = (id: string, typeName: string): PluginDetail => ({
  id,
  displayName: typeName,
  hostApi: 1,
  capabilities: ["connections", "mcp-servers"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${id}/${id}`,
      definition: { type: `${id}/${id}`, displayName: typeName, setup: [] },
    },
    {
      extensionPoint: "mcp-server",
      id: `${id}/${id}`,
      definition: {
        displayName: typeName,
        description: `The ${typeName} MCP server.`,
        connectionType: `${id}/${id}`,
        origin: `https://mcp.${id}.example`,
      },
    },
  ],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
});

export const SENTRY_PLUGIN = buildPlugin("sentry", "Sentry");
export const LINEAR_PLUGIN = buildPlugin("linear", "Linear");
export const OFFERING_PLUGINS: readonly PluginDetail[] = [SENTRY_PLUGIN, LINEAR_PLUGIN];

/** Returns a connected Connection of `type`, labelled `label`, that acts as `displayName`. */
export const buildConnection = (
  id: string,
  type: string,
  label: string,
  displayName = label,
): Connection => ({
  id,
  type,
  label,
  displayName,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
});

export const SENTRY_WORK_CONNECTION = buildConnection("c-work", "sentry/sentry", "work");
export const SENTRY_HOBBY_CONNECTION = buildConnection("c-hobby", "sentry/sentry", "hobby");
export const LINEAR_CONNECTION = buildConnection("c-linear", "linear/linear", "acme");
export const CONNECTIONS: readonly Connection[] = [
  SENTRY_WORK_CONNECTION,
  SENTRY_HOBBY_CONNECTION,
  LINEAR_CONNECTION,
];

/**
 * Returns a ready server named `name`, reached with the Connection
 * `connectionId` through the plugin of the same name, with two tools that
 * were listed at the last check. `overrides` change any field.
 */
export const buildServer = (
  id: string,
  name: string,
  connectionId: string,
  overrides: Partial<McpServer> = {},
): McpServer => ({
  id,
  name,
  source: { kind: "plugin", contributionId: `${name}/${name}`, connectionId },
  enabled: true,
  status: "ready",
  statusDetail: null,
  tools: [
    { name: "search", description: "Searches." },
    { name: "read", description: "Reads." },
  ],
  checkedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

export const SENTRY_WORK = buildServer("s-work", "sentry", "c-work");
export const SENTRY_HOBBY = buildServer("s-hobby", "sentry", "c-hobby");
export const LINEAR = buildServer("s-linear", "linear", "c-linear");

/** Returns the views of `servers` on the fixture Connections and plugins. */
export const buildViews = (servers: readonly McpServer[]): McpServerView[] =>
  buildMcpServerViews(servers, CONNECTIONS, OFFERING_PLUGINS);

/** What a project needs to be in the fake controller's world. */
export interface FakeMcpProject {
  readonly id: string;
  readonly mcpServerIds: readonly string[];
}

/** What the fake controller holds. A test changes it to play another client's write. */
export interface McpWorld<P extends FakeMcpProject = Project> {
  servers: McpServer[];
  projects: P[];
  /** The setting `thread.mcpServerIds`, as stored: it may name a deleted server. */
  defaultIds: string[];
  /** The ids `mcpServer.check` was called on, in order. */
  checked: string[];
  /** The tokens `mcpServer.setToken` was called with, in order. */
  tokens: { readonly id: string; readonly token: string }[];
}

export interface McpWorldOptions<P extends FakeMcpProject = Project> {
  readonly servers: readonly McpServer[];
  readonly projects: readonly P[];
  readonly defaultIds?: readonly string[] | undefined;
}

/** Returns a world that holds copies of the lists in `options`. */
export const buildMcpWorld = <P extends FakeMcpProject = Project>(
  options: McpWorldOptions<P>,
): McpWorld<P> => ({
  servers: [...options.servers],
  projects: [...options.projects],
  defaultIds: [...(options.defaultIds ?? [])],
  checked: [],
  tokens: [],
});

export interface McpControllerOptions {
  /** The ids that servers created through `mcpServer.create` get, in order. */
  readonly createdIds?: readonly string[];
  /** Settings the user holds besides `thread.mcpServerIds`, which every read returns too. */
  readonly otherUserSettings?: Readonly<Record<string, unknown>>;
}

const notFound = (what: string): Answer => ({
  status: 404,
  body: buildErrorBody("not_found", `no ${what}`),
});

/**
 * Returns the handlers that play the controller on `world`: the MCP
 * servers' reads and writes, the projects' list and update, and the settings'
 * read and update. The handlers read the world when they answer, so a test
 * that changes the world changes the next answer. The Connections' and the
 * plugins' lists are not here: a test serves them as it needs.
 *
 * The handlers of one server exist for each server the world holds when this
 * is called and for each of `createdIds`, so a test that adds a server to the
 * world calls this after.
 *
 * - `mcpServer.create` refuses `conflict` for a second server of one
 *   contribution and Connection, or of one address (`mcp-server-exists`), and
 *   otherwise adds a server that is `checking` with no tools, under the next
 *   of `createdIds`. A server added by URL has no sign-in until a token is set.
 * - `mcpServer.update` takes `enabled`, and `source` (Replace), which moves a
 *   server added by URL onto the plugin's Connection.
 * - `mcpServer.setToken` records the token, and marks the server `checking`
 *   with a pasted token as its sign-in.
 * - `mcpServer.delete` drops the server from every project's list. It leaves
 *   the default list as stored, and reading the settings drops the ids of
 *   deleted servers, as the controller does.
 * - `mcpServer.check` marks the server `checking` and records the call. The
 *   test plays the check's end by changing the world and pushing `mcpServer`.
 */
export const buildMcpControllerHandlers = <P extends FakeMcpProject>(
  world: McpWorld<P>,
  options: McpControllerOptions = {},
): Record<string, Handler> => {
  const createdIds = options.createdIds ?? [];
  const replaceServer = (id: string, change: Partial<McpServer>): McpServer | undefined => {
    const current = world.servers.find((each) => each.id === id);
    if (current === undefined) return undefined;
    const next = { ...current, ...change };
    world.servers = world.servers.map((each) => (each.id === id ? next : each));
    return next;
  };
  const readSettings = () => ({
    controller: {},
    user: {
      ...options.otherUserSettings,
      "thread.mcpServerIds": world.defaultIds.filter((id) =>
        world.servers.some((each) => each.id === id),
      ),
    },
  });
  const handlers: Record<string, Handler> = {
    "GET /api/v1/projects": () => ({ body: { items: world.projects } }),
    "GET /api/v1/settings": () => ({ body: readSettings() }),
    "PATCH /api/v1/settings": (call) => {
      world.defaultIds = (call.body as { user: { "thread.mcpServerIds": string[] } }).user[
        "thread.mcpServerIds"
      ];
      return { body: readSettings() };
    },
    "GET /api/v1/mcp-servers": () => ({
      body: { items: world.servers.toSorted((a, b) => a.name.localeCompare(b.name)) },
    }),
    "POST /api/v1/mcp-servers": (call) => {
      const { source } = call.body as {
        source: {
          kind: string;
          url?: string;
          name?: string;
          contributionId: string;
          connectionId: string;
        };
      };
      const id = createdIds[world.servers.filter((each) => createdIds.includes(each.id)).length]!;
      const checking = { status: "checking", tools: [], checkedAt: null } as const;
      if (source.kind === "url") {
        const url = source.url!;
        const holder = world.servers.find(
          (each) => each.source.kind === "url" && each.source.url === url,
        );
        if (holder !== undefined) {
          return {
            status: 409,
            body: {
              error: {
                code: "conflict",
                message: "This address is added already.",
                details: { reason: "mcp-server-exists", mcpServerId: holder.id },
              },
            },
          };
        }
        const host = new URL(url).hostname.split(".");
        const name =
          source.name ?? host.find((label) => !["mcp", "www", "api"].includes(label)) ?? "server";
        const created = buildServer(id, name, "unused", {
          ...checking,
          source: { kind: "url", url, signIn: "none", signInOffered: null },
        });
        world.servers = [...world.servers, created];
        return { body: created };
      }
      if (
        world.servers.some(
          (each) =>
            each.source.kind === "plugin" &&
            each.source.contributionId === source.contributionId &&
            each.source.connectionId === source.connectionId,
        )
      ) {
        return {
          status: 409,
          body: buildErrorBody(
            "conflict",
            "A server for this Connection already exists. Open it in the list.",
          ),
        };
      }
      const created = buildServer(
        id,
        source.contributionId.split("/")[1]!,
        source.connectionId,
        checking,
      );
      world.servers = [...world.servers, created];
      return { body: created };
    },
  };
  for (const id of [...world.servers.map((each) => each.id), ...createdIds]) {
    handlers[`GET /api/v1/mcp-servers/${id}`] = () => {
      const found = world.servers.find((each) => each.id === id);
      return found === undefined ? notFound("server") : { body: found };
    };
    handlers[`PATCH /api/v1/mcp-servers/${id}`] = (call) => {
      const { enabled, source } = call.body as {
        enabled?: boolean;
        source?: { kind: "plugin"; contributionId: string; connectionId: string };
      };
      const next = replaceServer(id, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(source === undefined ? {} : { source }),
      });
      return next === undefined ? notFound("server") : { body: next };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/token`] = (call) => {
      const { token } = call.body as { token: string };
      const current = world.servers.find((each) => each.id === id);
      if (current === undefined) return notFound("server");
      if (current.source.kind !== "url") {
        return {
          status: 409,
          body: buildErrorBody("invalid_state", "This server is reached with a Connection."),
        };
      }
      world.tokens.push({ id, token });
      const next = replaceServer(id, {
        status: "checking",
        source: { ...current.source, signIn: "token" },
      });
      return { body: next };
    };
    handlers[`DELETE /api/v1/mcp-servers/${id}`] = () => {
      world.servers = world.servers.filter((each) => each.id !== id);
      world.projects = world.projects.map((project) => ({
        ...project,
        mcpServerIds: project.mcpServerIds.filter((each) => each !== id),
      }));
      return { body: {} };
    };
    handlers[`POST /api/v1/mcp-servers/${id}/check`] = () => {
      world.checked.push(id);
      replaceServer(id, { status: "checking" });
      return { body: {} };
    };
  }
  for (const { id } of world.projects) {
    handlers[`PATCH /api/v1/projects/${id}`] = (call) => {
      const { mcpServerIds } = call.body as { mcpServerIds: string[] };
      const index = world.projects.findIndex((each) => each.id === id);
      const next = { ...world.projects[index]!, mcpServerIds };
      world.projects[index] = next;
      return { body: next };
    };
  }
  return handlers;
};
