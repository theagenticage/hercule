/**
 * The thread specimen for MCP servers: the app, booted through its own router
 * over a fake controller (mcp-scene.ts), with the Fix thread open, started in
 * webshop with three servers, one of which needs sign-in (mcp-fixture.ts).
 * `capture:ui` captures its two states (scripts/ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state its `?state=` names:
 * - none or `menu`: the composer's `+` menu open, with its "MCP servers"
 *   submenu beside it;
 * - `lines`: the transcript holds the line about a server left out at the
 *   start, with Reconnect, and the line about a refused call, with Open server.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { MCP_RECORDS, MCP_THREAD, MCP_THREAD_LINES } from "./mcp-fixture";
import { pressPart, waitForPart, waitForParts } from "./mcp-script";
import type { ProductionPage } from "./production-page";
import type { ThreadScreenRecords } from "./shell-page";
import { markMcpSceneReady, mountMcpScene } from "./mcp-scene";

/** Returns the address of the thread's page. */
const openThreadAddress = (thread: ThreadScreenRecords): string => `/threads/${thread.session.id}`;

const state = new URLSearchParams(location.search).get("state") ?? "menu";

let page: ProductionPage;
if (state === "lines") {
  page = await mountMcpScene(
    {
      records: MCP_THREAD_LINES.records,
      mcp: MCP_THREAD_LINES.servers,
      thread: MCP_THREAD_LINES.thread,
    },
    openThreadAddress(MCP_THREAD_LINES.thread),
  );
  await waitForPart(".tx-item");
  // Each line is drawn as a plain warning until its code has loaded, and then
  // gets its button.
  await waitForParts(".error-note button", 2);
  // The `+` is final once its menu has loaded (the button then opens a popover)
  // and the thread's list holds the server that needs sign-in, which puts a
  // red dot on it. Capturing before that catches the plain `+` that stands in.
  await waitForPart(".composer-row button.plus-button[popovertarget] .plus-dot");
} else if (state === "menu") {
  page = await mountMcpScene(
    { records: MCP_THREAD.records, mcp: MCP_RECORDS, thread: MCP_THREAD.thread },
    openThreadAddress(MCP_THREAD.thread),
  );
  await waitForPart(".tx-item");
  // The `+` is a plain button until the menu's code has loaded.
  await pressPart(".composer-row button.plus-button[popovertarget]");
  await pressPart('[data-item="servers"]');
  await waitForPart(".plus-sub .plus-row");
} else {
  throw new Error(`The thread MCP specimen draws no state "${state}".`);
}
await markMcpSceneReady(page);
