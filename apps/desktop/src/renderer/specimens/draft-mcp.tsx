/**
 * The Draft Thread specimen for MCP servers: the app, booted through its own
 * router over a fake controller (mcp-scene.ts), with a Draft Thread in webshop
 * open, whose composer's `+` menu is open with its "MCP servers" submenu beside
 * it (mcp-fixture.ts). The draft starts with webshop's three servers, one of
 * which needs sign-in. `capture:ui` captures it (scripts/ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { MCP_DRAFT, MCP_RECORDS } from "./mcp-fixture";
import { pressPart, waitForPart } from "./mcp-script";
import { markMcpSceneReady, mountMcpScene } from "./mcp-scene";

const page = await mountMcpScene(
  { records: MCP_DRAFT.records, mcp: MCP_RECORDS, draft: MCP_DRAFT.draft },
  `/?project=${MCP_DRAFT.draft.projectId}`,
);
// The starters load the first time they show, so they arrive after the first render.
await waitForPart(".start");
// The `+` is a plain button until the menu's code has loaded.
await pressPart(".composer-row button.plus-button[popovertarget]");
await pressPart('[data-item="servers"]');
await waitForPart(".plus-sub .plus-row");
await markMcpSceneReady(page);
