/**
 * The stubbed controller the Settings > MCP servers tests share: a world of
 * plugins, Connections, servers, projects and the default list, and the
 * handlers that answer the reads and writes on them the way the controller
 * does after a write. A write changes the world, and the next read returns
 * the change, so a screen that reads again shows it.
 */
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { buildErrorBody, type Answer, type Call, type Handler } from "@hercule/client-core/testing";
import type { Connection, McpServer, Project } from "@hercule/contract";
import { SHARED_READ_WINDOW_MS } from "../../../app/live";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type RenderedApp,
} from "../../../app/testing";
import {
  buildServer,
  OFFERING_CONNECTIONS,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_WORK,
} from "./mcp-servers.testing";

export const [WEBSHOP, OPS] = SIDEBAR_FIXTURE.projects as readonly [Project, Project];

/** The ids a server created by a test gets, in order. Every one has its handlers from the start. */
const NEW_SERVER_IDS = [1, 2, 3, 4].map(
  (n) => `01a06d02-8300-7000-8000-${String(n).padStart(12, "0")}`,
);

/** What the stubbed controller holds. A test changes it to play another client's write. */
export interface McpWorld {
  servers: McpServer[];
  connections: Connection[];
  projects: Project[];
  /** The setting `thread.mcpServerIds`. */
  defaultIds: string[];
  /** The ids `mcpServer.check` was called on, in order. */
  checked: string[];
}

export interface OpenWorldOptions {
  readonly servers?: readonly McpServer[];
  readonly connections?: readonly Connection[];
  readonly projects?: readonly Project[];
  readonly defaultIds?: readonly string[];
  /** Handlers that answer in place of the world's. */
  readonly handlers?: Readonly<Record<string, Handler>>;
}

const notFound = (what: string): Answer => ({
  status: 404,
  body: buildErrorBody("not_found", `no ${what}`),
});

/**
 * Returns the world and the handlers that play the controller on it: the MCP
 * servers' reads and writes, the projects' list and update, the settings'
 * read and update, and the Connections' list.
 *
 * - `mcpServer.create` refuses `conflict` for a second server of one
 *   contribution and Connection, and otherwise adds a server that is
 *   `checking` with no tools, under the next of `NEW_SERVER_IDS`.
 * - `mcpServer.delete` drops the server from every project's list and from
 *   the default list, as the controller does.
 * - `mcpServer.check` marks the server `checking` and records the call. The
 *   test plays the check's end by changing the world and pushing `mcpServer`.
 */
export const buildMcpWorld = (
  options: OpenWorldOptions,
): { readonly world: McpWorld; readonly handlers: Record<string, Handler> } => {
  const world: McpWorld = {
    servers: [...(options.servers ?? [SENTRY_WORK, SENTRY_HOBBY])],
    connections: [...(options.connections ?? OFFERING_CONNECTIONS)],
    projects: [...(options.projects ?? [WEBSHOP, OPS])],
    defaultIds: [...(options.defaultIds ?? [])],
    checked: [],
  };
  const sorted = (): McpServer[] => world.servers.toSorted((a, b) => a.name.localeCompare(b.name));
  const replaceServer = (id: string, change: Partial<McpServer>): McpServer | undefined => {
    const current = world.servers.find((each) => each.id === id);
    if (current === undefined) return undefined;
    const next = { ...current, ...change };
    world.servers = world.servers.map((each) => (each.id === id ? next : each));
    return next;
  };
  const handlers: Record<string, Handler> = {
    "GET /api/v1/connections": () => ({ body: { items: world.connections } }),
    "GET /api/v1/projects": () => ({ body: { items: world.projects } }),
    "GET /api/v1/settings": () => ({
      body: { controller: {}, user: { "thread.mcpServerIds": world.defaultIds } },
    }),
    "PATCH /api/v1/settings": (call) => {
      const ids = (call.body as { user: { "thread.mcpServerIds": string[] } }).user[
        "thread.mcpServerIds"
      ];
      world.defaultIds = ids;
      return { body: { controller: {}, user: { "thread.mcpServerIds": ids } } };
    },
    "GET /api/v1/mcp-servers": () => ({ body: { items: sorted() } }),
    "POST /api/v1/mcp-servers": (call) => {
      const { source } = call.body as {
        source: { contributionId: string; connectionId: string };
      };
      if (
        world.servers.some(
          (each) =>
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
      const connection = world.connections.find((each) => each.id === source.connectionId)!;
      const id =
        NEW_SERVER_IDS[world.servers.filter((each) => NEW_SERVER_IDS.includes(each.id)).length]!;
      const created = buildServer(id, source.contributionId.split("/")[1]!, connection, {
        status: "checking",
        tools: [],
        checkedAt: null,
      });
      world.servers = [...world.servers, created];
      return { body: created };
    },
  };
  for (const id of [...world.servers.map((each) => each.id), ...NEW_SERVER_IDS]) {
    handlers[`GET /api/v1/mcp-servers/${id}`] = () => {
      const found = world.servers.find((each) => each.id === id);
      return found === undefined ? notFound("server") : { body: found };
    };
    handlers[`PATCH /api/v1/mcp-servers/${id}`] = (call) => {
      const { enabled } = call.body as { enabled: boolean };
      const next = replaceServer(id, { enabled });
      return next === undefined ? notFound("server") : { body: next };
    };
    handlers[`DELETE /api/v1/mcp-servers/${id}`] = () => {
      world.servers = world.servers.filter((each) => each.id !== id);
      world.projects = world.projects.map((project) => ({
        ...project,
        mcpServerIds: project.mcpServerIds.filter((each) => each !== id),
      }));
      world.defaultIds = world.defaultIds.filter((each) => each !== id);
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
      const current = world.projects.find((each) => each.id === id)!;
      const next = { ...current, mcpServerIds };
      world.projects = world.projects.map((each) => (each.id === id ? next : each));
      return { body: next };
    };
  }
  return { world, handlers: { ...handlers, ...options.handlers } };
};

/** What `openAt` returns: the rendered app, the stubbed controller's world and the requests it received. */
export interface OpenedMcpApp extends RenderedApp {
  readonly world: McpWorld;
  readonly calls: readonly Call[];
}

/**
 * Opens the app at `path` on a controller that holds `options`. It waits for
 * the first pushes on every topic, and for the `mcpServer` topic's too when
 * the screen holds it, so the reads they cause are not a test's own.
 */
export const openAt = async (
  path: string,
  options: OpenWorldOptions = {},
): Promise<OpenedMcpApp> => {
  stubElementSize(272, 800);
  const { world, handlers } = buildMcpWorld(options);
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: OFFERING_PLUGINS }),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await app.live.waitForFirstPushes();
  if (path.startsWith("/settings/mcp-servers") || path === "/settings/connections") {
    await waitForTopicReads(app);
  }
  return { ...app, world, calls };
};

/**
 * Waits until the app holds the `mcpServer` topic, the first push on it has
 * arrived and the reads it started have finished.
 */
export const waitForTopicReads = async (app: RenderedApp): Promise<void> => {
  await waitFor(() => {
    expect(app.live.readTopics()).toContain("mcpServer");
  });
  await new Promise((resolve) => setTimeout(resolve, SHARED_READ_WINDOW_MS + 10));
  await waitFor(() => {
    expect(app.context.queryClient.isFetching()).toBe(0);
  });
};

/** Returns the calls among `calls` made with `method` on `path`. */
export const findCalls = (calls: readonly Call[], method: string, path: string): Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

export const SERVER_LIST_PATH = "/api/v1/mcp-servers";

export const LIST_PATH = "/settings/mcp-servers";

/** Opens Settings > MCP servers and waits for its header. */
export const openList = async (options: OpenWorldOptions = {}): Promise<OpenedMcpApp> => {
  const app = await openAt(LIST_PATH, options);
  await screen.findByRole("heading", { level: 1, name: "MCP servers" });
  return app;
};

/**
 * Opens the page of the server `server`, whose world holds only it unless
 * `options` say otherwise, and waits for the header, which names the server.
 */
export const openPage = async (
  server: McpServer,
  options: OpenWorldOptions = {},
): Promise<OpenedMcpApp> => {
  const app = await openAt(`${LIST_PATH}/${server.id}`, { servers: [server], ...options });
  await screen.findByRole("heading", { level: 1, name: server.name });
  return app;
};

/** Returns the row of the list whose name cell starts with `name`, such as "sentry work". */
export const findRow = (name: string): HTMLElement => {
  const row = [...document.querySelectorAll<HTMLElement>(".mcp-row")].find((each) =>
    each.querySelector(".mcp-name")?.textContent?.startsWith(name),
  );
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

/** Returns the text of each cell of `row`, as the list draws them. */
export const readCells = (row: HTMLElement): string[] =>
  [...row.children].map((cell) => cell.textContent ?? "");
