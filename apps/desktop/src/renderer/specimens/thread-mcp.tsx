/**
 * The thread specimen for MCP servers: the app's real shell with the Fix
 * thread open, started in webshop with three servers, one of which needs
 * sign-in (mcp-fixture.ts). `capture:ui` captures its two states
 * (scripts/ui-screens.ts).
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
import { mountThreadSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const state = new URLSearchParams(location.search).get("state") ?? "menu";

if (state === "lines") {
  await mountThreadSpecimen(
    MCP_THREAD_LINES.records,
    MCP_THREAD_LINES.thread,
    MCP_THREAD_LINES.servers,
  );
  // Each line is drawn as a plain warning until its code has loaded, and then
  // gets its button.
  await waitForParts(".error-note button", 2);
} else if (state === "menu") {
  await mountThreadSpecimen(MCP_THREAD.records, MCP_THREAD.thread, MCP_RECORDS);
  // The `+` is a plain button until the menu's code has loaded.
  await pressPart(".composer-row button.plus-button[popovertarget]");
  await pressPart('[data-item="servers"]');
  await waitForPart(".plus-sub .plus-row");
} else {
  throw new Error(`The thread MCP specimen draws no state "${state}".`);
}
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
