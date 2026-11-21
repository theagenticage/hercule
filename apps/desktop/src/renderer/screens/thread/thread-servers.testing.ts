/**
 * The helpers the tests of the composer's `+` menu and of a thread's lines
 * about MCP servers share: the app opened on a draft or a thread over the MCP
 * world of Settings' tests, a thread that `session.update` changes, and the
 * menu's popovers, which jsdom does not implement.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { Call, Handler } from "@hercule/client-core/testing";
import type { McpServer, Session } from "@hercule/contract";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  FIXTURE_MODEL_PROFILE,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type RenderedApp,
  type ThreadRecords,
} from "../../app/testing";
import {
  buildMcpWorld,
  type McpWorld,
  type OpenWorldOptions,
} from "../settings/mcp-servers/mcp-world.testing";
import { OFFERING_PLUGINS } from "../settings/mcp-servers/mcp-servers.testing";

export { findCalls, WEBSHOP, OPS } from "../settings/mcp-servers/mcp-world.testing";

/** What `openComposerApp` takes besides the world's options. */
export interface OpenComposerOptions extends OpenWorldOptions {
  /**
   * The thread the controller holds, whose composer is under test when `path` opens it, and which
   * every thread a draft starts is. The idle fixture thread when left out.
   */
  readonly thread?: ThreadRecords;
  /** Called before `session.update` answers, so a test can hold the write while it looks at the screen. */
  readonly holdWrite?: () => Promise<unknown>;
}

/** What `openComposerApp` returns. */
export interface OpenedComposerApp extends RenderedApp {
  readonly world: McpWorld;
  readonly calls: readonly Call[];
  /** Returns the session the stubbed controller holds now, which `session.update` changes. */
  readonly readSession: () => Session;
}

/**
 * Opens the app at `path` with the MCP world `options` describe and the
 * thread `thread`, whose session `PATCH /sessions/:id` changes the way the
 * controller does: the list it stores is the ids given, each with the name of
 * its server. Waits for the first pushes, so the reads they cause are not a
 * test's own.
 */
export const openComposerApp = async (
  path: string,
  { thread = THREAD_FIXTURES.finished, holdWrite, ...options }: OpenComposerOptions = {},
): Promise<OpenedComposerApp> => {
  stubElementSize(800, 800);
  const { world, handlers } = buildMcpWorld(options);
  let session = thread.session;
  const sessionHandlers: Record<string, Handler> = {
    ...buildThreadHandlers(thread),
    [`GET /api/v1/sessions/${thread.session.id}`]: () => ({ body: session }),
    [`PATCH /api/v1/sessions/${thread.session.id}`]: async (call) => {
      await holdWrite?.();
      const { mcpServerIds } = call.body as { mcpServerIds: string[] };
      session = {
        ...session,
        mcpServers: mcpServerIds.map((id) => ({
          mcpServerId: id,
          name: world.servers.find((each) => each.id === id)?.name ?? "gone",
          leftOut: null,
        })),
      };
      return { body: session };
    },
  };
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      accounts: [FIXTURE_ACCOUNT],
      modelProfiles: [FIXTURE_MODEL_PROFILE],
      plugins: OFFERING_PLUGINS,
    }),
    ...sessionHandlers,
    "POST /api/v1/sessions": { body: thread.session },
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await screen.findByRole("textbox", { name: "Message" });
  await app.live.waitForFirstPushes();
  return { ...app, world, calls, readSession: () => session };
};

/** Returns a session with the servers `servers` in its list, none of them left out. */
export const withServers = (
  thread: ThreadRecords,
  servers: readonly McpServer[],
): ThreadRecords => ({
  ...thread,
  session: {
    ...thread.session,
    mcpServers: servers.map((server) => ({
      mcpServerId: server.id,
      name: server.name,
      leftOut: null,
    })),
  },
});

/** Returns the popover of the `+` menu, once the menu's code has loaded and replaced the plain `+`. */
export const findPlusPopover = async (): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(document.querySelector("[popover][aria-label='Add']")).not.toBeNull();
  });
  return document.querySelector<HTMLElement>("[popover][aria-label='Add']")!;
};

/** Sends the popover the `toggle` event the browser sends when it opens or closes. */
export const toggleMenu = (popover: HTMLElement, newState: "open" | "closed"): void => {
  act(() => {
    fireEvent(popover, Object.assign(new Event("toggle"), { newState }));
  });
};

/** Opens the `+` menu and presses its "MCP servers" row, which opens the submenu. Returns the popover. */
export const openServersSubmenu = async (): Promise<HTMLElement> => {
  const popover = await findPlusPopover();
  toggleMenu(popover, "open");
  fireEvent.click(within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true }));
  await within(popover).findByRole("group", { name: "Servers of this thread", hidden: true });
  await waitFor(() => {
    expect(popover.querySelector(".plus-row")).not.toBeNull();
  });
  return popover;
};

/** Returns the words on the menu's "MCP servers" row. */
export const readServersRowWords = (popover: HTMLElement): string =>
  popover.querySelector(".plus-fine")?.textContent ?? "";

/** Returns the names the submenu's rows show, in order, each with its account when it shows one. */
export const readSubmenuRows = (popover: HTMLElement): string[] =>
  [...popover.querySelectorAll(".plus-row")].map(
    (row) => row.querySelector(".mcp-name")?.textContent ?? "",
  );

/** Returns the switch of the submenu row named `name`. */
export const findSwitch = (name: string): HTMLElement =>
  screen.getByRole("switch", { name: `${name} in this thread`, hidden: true });

/**
 * Waits until the app holds the `mcpServer` topic, its first push has arrived
 * and the reads it started have finished. That push reads the servers once
 * more (spec 17 §What MCP servers cost), so a test that counts the reads
 * waits for it first.
 */
export { waitForTopicReads } from "../settings/mcp-servers/mcp-world.testing";

/** Returns the requests that wrote a thread's list. */
export const readListWrites = (calls: readonly Call[], sessionId: string): Call[] =>
  calls.filter((call) => call.method === "PATCH" && call.path === `/api/v1/sessions/${sessionId}`);

/** Returns the requests that started a thread. */
export const readSpawns = (calls: readonly Call[]): Call[] =>
  calls.filter((call) => call.method === "POST" && call.path === "/api/v1/sessions");
