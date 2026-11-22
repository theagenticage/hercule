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
import type { EventCountsByConnection } from "@hercule/contract";
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
  /** The thread the scene opens. */
  readonly thread?: ThreadScreenRecords;
  /** The Draft Thread the scene opens. */
  readonly draft?: DraftScreenRecords;
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
  const { records, mcp, eventCounts, thread, draft } = scene;
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
    "GET /api/v1/mcp-servers": { body: { items: mcp.servers } },
    ...Object.fromEntries(
      mcp.servers.map((server) => [`GET /api/v1/mcp-servers/${server.id}`, { body: server }]),
    ),
    "GET /api/v1/events/counts": { body: eventCounts ?? { connections: [] } },
  };
  if (thread !== undefined) {
    const path = `/api/v1/sessions/${thread.session.id}`;
    handlers[`GET ${path}`] = { body: thread.session };
    handlers[`GET ${path}/subagents`] = { body: { items: [] } };
    handlers[`GET ${path}/transcript`] = { body: { items: thread.transcript } };
    handlers[`GET ${path}/inputs`] = { body: { items: thread.queuedInputs } };
    handlers[`GET ${path}/skills`] = { body: { items: [], skipped: [] } };
  }
  if (draft !== undefined) handlers["GET /api/v1/tasks"] = { body: { items: draft.startTasks } };
  return handlers;
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
    prepare: ({ controller }) => {
      if (draft === undefined || controller === null) return;
      for (const entry of draft.recent ?? []) rememberRecentModel(CONTROLLER_URL, entry);
      controller.pendingSubmissions.writePicks(buildDraftKey(draft.projectId, null), draft.picks);
    },
  });
}

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
