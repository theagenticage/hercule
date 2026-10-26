/**
 * The sidebar rows specimen: the app's real shell and sidebar, drawn from the
 * records in sidebar-rows-fixture.ts, which hold one row each of 1, 2, 3 and
 * 10 Threads. No capture script draws it now; open it in the dev server for a
 * check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { OPEN_SESSION_ID, ROWS_RECORDS } from "./sidebar-rows-fixture";
import { mountSidebarSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

// The rows' layer: Chromium antialiases the text of a list drawn in a layer of its own up to 3
// levels differently from the same list drawn in the page's layer, on every row. The list asks
// for a layer of its own, so that its text is drawn the same way on every run.
const layer = document.createElement("style");
layer.textContent = ".side-scroll { will-change: transform; }";
document.head.append(layer);

await mountSidebarSpecimen(ROWS_RECORDS, `/threads/${OPEN_SESSION_ID}`);
await markSheetReady();
