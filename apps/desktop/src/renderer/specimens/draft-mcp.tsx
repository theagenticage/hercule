/**
 * The Draft Thread specimen for MCP servers: the app's real shell with a
 * Draft Thread in webshop open, whose composer's `+` menu is open with its
 * "MCP servers" submenu beside it (mcp-fixture.ts). The draft starts with
 * webshop's three servers, one of which needs sign-in. `capture:ui` captures
 * it (scripts/ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { MCP_DRAFT, MCP_RECORDS } from "./mcp-fixture";
import { pressPart, waitForPart } from "./mcp-script";
import { mountDraftSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountDraftSpecimen(MCP_DRAFT.records, MCP_DRAFT.draft, MCP_RECORDS);
// The `+` is a plain button until the menu's code has loaded.
await pressPart(".composer-row button.plus-button[popovertarget]");
await pressPart('[data-item="servers"]');
await waitForPart(".plus-sub .plus-row");
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
