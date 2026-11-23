/**
 * What an MCP scene needs to boot the app's own router over a fake
 * controller (production-page.tsx): the handlers that answer the scene's
 * records, and the readiness check every scene ends with.
 *
 * A scene is Settings > MCP servers, Settings > Connections, or a thread's or
 * a Draft Thread's composer, all drawn from the world in mcp-fixture.ts. The
 * app reads the records through its own loaders, as it does against a
 * controller, so a request the handlers do not answer shows up in
 * `listUnknownRequests` and fails the scene.
 */
import type { Handler } from "@hercule/client-core/testing";
import type { Bridge } from "../../ipc/bridge";
import type { EventCountsByConnection, McpServer } from "@hercule/contract";
import { BOOT_HANDLERS, buildSidebarHandlers } from "../app/fake-controller";
import type { SidebarRecords as ControllerRecords } from "../app/fake-controller";
import { buildDraftKey } from "../app/pending-submissions";
import { rememberRecentModel } from "../app/recent-models";
import { buildFixtureIdConverter } from "./fixture-ids";
import type { McpServersRecords } from "./mcp-fixture";
import { waitForPart } from "./mcp-script";
import { CONTROLLER_URL, mountProductionApp, type ProductionPage } from "./production-page";
import { applySheetAppearance, markSheetReady, readSheetAppearance } from "./sheet-page";
import type { DraftScreenRecords, SidebarRecords, ThreadScreenRecords } from "./shell-page";

/** The records of one MCP scene. */
export interface McpScene {
  /** The shell's lists, with the Connections and plugins the scene reads. */
  readonly records: SidebarRecords;
  /** The servers and the default list. */
  readonly mcp: McpServersRecords;
  /** What Settings > Connections reads of the events each Connection received. None when the scene reads none. */
  readonly eventCounts?: EventCountsByConnection;
  /**
   * What `mcpServer.create` answers, for a scene whose Add by URL dialog is
   * used. An answer with status 200 holds the new server: it is listed and
   * readable from then on. The ids in it follow the scene's id conversion.
   */
  readonly create?: { readonly status: number; readonly body: unknown };
  /**
   * What `mcpServer.startSignIn` answers, for a scene whose sign-in dialog is
   * used, on every server of the scene.
   */
  readonly signIn?: { readonly status: number; readonly body: unknown };
  /**
   * What `mcpServer.update` answers, for a scene whose Replace dialog is
   * pressed, on every server of the scene.
   */
  readonly update?: { readonly status: number; readonly body: unknown };
  /**
   * For a scene whose sign-in dialog is drawn after main started its listener
   * for the browser's return, so the waiting step is the one a Mac shows:
   * `listens`, and the browser never comes back, or `times-out`, and main
   * reports at once that it did not come back within 10 minutes. Without it,
   * main cannot listen, and the sign-in shows its paste step.
   */
  readonly signInReturn?: "listens" | "times-out";
  /** False for a scene where main cannot open the browser. */
  readonly browserOpens?: boolean;
  /** The thread the scene opens. */
  readonly thread?: ThreadScreenRecords;
  /** The Draft Thread the scene opens. */
  readonly draft?: DraftScreenRecords;
  /** Handlers that answer in place of the scene's own, such as a read that fails. */
  readonly handlers?: Readonly<Record<string, Handler>>;
}

/** Converts the shell's lists to the records the fake controller answers from. */
const buildControllerRecords = (records: SidebarRecords): ControllerRecords => ({
  threads: records.threads,
  projects: records.projects,
  workspaces: records.workspaces,
  resources: records.resources,
  runners: records.runners,
  accounts: records.accounts,
  username: records.user.username,
  assistants: records.assistants.map(({ assistant, currentSession }) => ({
    assistant,
    session: currentSession,
  })),
  ...(records.modelProfiles === undefined ? {} : { modelProfiles: records.modelProfiles }),
  ...(records.plugins === undefined ? {} : { plugins: records.plugins }),
  ...(records.agentSessions === undefined ? {} : { agentSessions: records.agentSessions }),
});

/** Returns the handlers that answer every read of `scene`. */
export function buildMcpSceneHandlers(scene: McpScene): Record<string, Handler> {
  const {
    records,
    mcp,
    eventCounts,
    thread,
    draft,
    create,
    signIn,
    update,
    handlers: replacements,
  } = scene;
  // The server `mcpServer.create` made, once it has been called.
  let created: McpServer | undefined;
  const handlers: Record<string, Handler> = {
    ...BOOT_HANDLERS,
    ...buildSidebarHandlers(buildControllerRecords(records)),
    "GET /api/v1/connections": { body: { items: records.connections ?? [] } },
    // The book's times are UTC, and so is the scene's clock.
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { timezone: "UTC", "thread.mcpServerIds": mcp.defaultServerIds },
      },
    },
    "GET /api/v1/mcp-servers": () => ({
      body: { items: created === undefined ? mcp.servers : [...mcp.servers, created] },
    }),
    ...Object.fromEntries(
      mcp.servers.map((server) => [`GET /api/v1/mcp-servers/${server.id}`, { body: server }]),
    ),
    "GET /api/v1/events/counts": { body: eventCounts ?? { connections: [] } },
  };
  if (create !== undefined) {
    handlers["POST /api/v1/mcp-servers"] = () => {
      if (create.status === 200) created = create.body as McpServer;
      return { status: create.status, body: create.body };
    };
    // Registered up front, because the returned handlers are a copy: a handler added
    // after the copy is made would never answer. Nothing reads the new server before
    // the call above makes it.
    if (create.status === 200) {
      const { id } = create.body as McpServer;
      handlers[`GET /api/v1/mcp-servers/${id}`] = { body: create.body };
    }
  }
  if (signIn !== undefined) {
    for (const { id } of mcp.servers) {
      handlers[`POST /api/v1/mcp-servers/${id}/sign-in`] = {
        status: signIn.status,
        body: signIn.body,
      };
    }
  }
  if (update !== undefined) {
    for (const { id } of mcp.servers) {
      handlers[`PATCH /api/v1/mcp-servers/${id}`] = { status: update.status, body: update.body };
    }
  }
  if (thread !== undefined) {
    const path = `/api/v1/sessions/${thread.session.id}`;
    handlers[`GET ${path}`] = { body: thread.session };
    handlers[`GET ${path}/subagents`] = { body: { items: [] } };
    handlers[`GET ${path}/transcript`] = { body: { items: thread.transcript } };
    handlers[`GET ${path}/inputs`] = { body: { items: thread.queuedInputs } };
    handlers[`GET ${path}/skills`] = { body: { items: [], skipped: [] } };
  }
  if (draft !== undefined) handlers["GET /api/v1/tasks"] = { body: { items: draft.startTasks } };
  return { ...handlers, ...replacements };
}

/**
 * Boots the app at `path` over the fake controller that holds `scene`, and
 * returns the page. The scene's theme comes from the URL, as for every
 * specimen. A Draft Thread's picks and recent models are in place before the
 * first screen loads, as if the user had made them.
 *
 * The fixtures' short ids become UUIDs (see `buildFixtureIdConverter`), in
 * `path` too, because the app decodes what the fake controller answers.
 */
export function mountMcpScene(
  fixtureScene: McpScene,
  fixturePath: string,
): Promise<ProductionPage> {
  applySheetAppearance();
  const convertIds = buildFixtureIdConverter(fixtureScene);
  const scene = convertIds(fixtureScene);
  const { draft } = scene;
  return mountProductionApp({
    handlers: buildMcpSceneHandlers(scene),
    path: fixturePath.replace(/[^/?=&]+/g, (part) => convertIds(part)),
    username: scene.records.user.username,
    appearance: readSheetAppearance(),
    ...(scene.signInReturn === undefined
      ? {}
      : { signInReturn: SIGN_IN_RETURNS[scene.signInReturn] }),
    ...(scene.browserOpens === false
      ? { linkOpen: () => Promise.resolve(BROWSER_NOT_OPENED) }
      : {}),
    prepare: ({ controller }) => {
      if (draft === undefined || controller === null) return;
      for (const entry of draft.recent ?? []) rememberRecentModel(CONTROLLER_URL, entry);
      controller.pendingSubmissions.writePicks(buildDraftKey(draft.projectId, null), draft.picks);
    },
  });
}

/** Main's answer when the system could not open the browser, in main's own sentence. */
const BROWSER_NOT_OPENED = {
  _tag: "NotOpened",
  reason: "The system could not open your default browser. Check that one is set.",
} as const;

/** Returns main's answers when it listens for the browser's return, and `wait` answers what became of the wait. */
const buildListeningReturn = (wait: Bridge["signInReturn"]["wait"]): Bridge["signInReturn"] => ({
  listen: () =>
    Promise.resolve({
      _tag: "listening",
      listenerId: "specimen",
      redirectUri: "http://127.0.0.1:4937/callback",
    }),
  wait,
  cancel: () => Promise.resolve(undefined),
});

/** The browser never comes back, or main gives up waiting for it. */
const SIGN_IN_RETURNS: Record<"listens" | "times-out", Bridge["signInReturn"]> = {
  listens: buildListeningReturn(() => new Promise(() => undefined)),
  "times-out": buildListeningReturn(() => Promise.resolve({ _tag: "timed-out" })),
};

/**
 * Waits until the page's sidebar has drawn and no read is running, fails when
 * the app sent a request the scene's handlers do not answer, then stops the
 * animations and marks the page ready for capture.
 */
export async function markMcpSceneReady(page: ProductionPage): Promise<void> {
  await waitForPart(".side-row");
  const { queryClient } = page.context;
  const deadline = performance.now() + 5000;
  while (queryClient.isFetching() > 0) {
    if (performance.now() > deadline) {
      throw new Error(
        "The MCP scene is still reading after five seconds. Check the page's console.",
      );
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const unknown = page.listUnknownRequests();
  if (unknown.length > 0) {
    throw new Error(
      `The app sent requests the MCP scene does not answer: ${[...new Set(unknown)].join(", ")}.`,
    );
  }
  const style = document.createElement("style");
  style.textContent = "* { animation: none !important; }";
  document.head.append(style);
  await markSheetReady();
}
