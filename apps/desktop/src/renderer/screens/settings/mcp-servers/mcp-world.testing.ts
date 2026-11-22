/**
 * The stubbed controller the Settings > MCP servers tests share: a world of
 * plugins, Connections, servers, projects and the default list, and the
 * handlers that answer the reads and writes on them the way the controller
 * does after a write. A write changes the world, and the next read returns
 * the change, so a screen that reads again shows it.
 */
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import {
  buildMcpControllerHandlers,
  buildMcpWorld as buildSharedMcpWorld,
  type McpWorld as SharedMcpWorld,
} from "@hercule/client-core/mcp-servers/testing";
import type { Call, Handler } from "@hercule/client-core/testing";
import type { Connection, McpServer, Project } from "@hercule/contract";
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
  OFFERING_CONNECTIONS,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_WORK,
} from "./mcp-servers.testing";

export const [WEBSHOP, OPS] = SIDEBAR_FIXTURE.projects as readonly [Project, Project];

/** The ids a server created by a test gets, in order. */
const NEW_SERVER_IDS = [1, 2, 3, 4].map(
  (n) => `01a06d02-8300-7000-8000-${String(n).padStart(12, "0")}`,
);

/** What the stubbed controller holds, with the Connections its list serves. */
export type McpWorld = SharedMcpWorld & { connections: Connection[] };

export interface OpenWorldOptions {
  readonly servers?: readonly McpServer[];
  readonly connections?: readonly Connection[];
  readonly projects?: readonly Project[];
  readonly defaultIds?: readonly string[];
  /** Handlers that answer in place of the world's. */
  readonly handlers?: Readonly<Record<string, Handler>>;
}

/**
 * Returns the world and the handlers that play the controller on it: the
 * shared fake controller of `@hercule/client-core/mcp-servers/testing`, and
 * the Connections' list.
 */
export const buildMcpWorld = (
  options: OpenWorldOptions,
): { readonly world: McpWorld; readonly handlers: Record<string, Handler> } => {
  const world: McpWorld = Object.assign(
    buildSharedMcpWorld({
      servers: options.servers ?? [SENTRY_WORK, SENTRY_HOBBY],
      projects: options.projects ?? [WEBSHOP, OPS],
      defaultIds: options.defaultIds,
    }),
    { connections: [...(options.connections ?? OFFERING_CONNECTIONS)] },
  );
  return {
    world,
    handlers: {
      ...buildMcpControllerHandlers(world, { createdIds: NEW_SERVER_IDS }),
      "GET /api/v1/connections": () => ({ body: { items: world.connections } }),
      ...options.handlers,
    },
  };
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
  // The stub answers the subscription in a microtask, and the reads that
  // answer starts begin after it is decoded, so let those start first.
  await new Promise((resolve) => setTimeout(resolve, 0));
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
