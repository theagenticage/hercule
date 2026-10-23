/**
 * The sidebar rows specimen: the app's real shell and sidebar, drawn from the
 * records in sidebar-rows-fixture.ts, which hold one row each of 1, 2, 3 and
 * 10 Threads. `pnpm compare:bureau` compares it pixel for pixel with the
 * sidebar of the Workbench, refined drawing's `?state=rows`, edited by
 * sidebar-rows-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { OPEN_SESSION_ID, ROWS_RECORDS } from "./sidebar-rows-fixture";
import { mountSidebarSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

// The rows' layer: the app's list and the drawing's list are drawn in
// different layers, and Chromium antialiases the text of one layer up to 3
// levels differently from the other's, on every row. Both pages ask for a
// layer of their own for the list, so that they draw the text alike.
const layer = document.createElement("style");
layer.textContent = ".side-scroll { will-change: transform; }";
document.head.append(layer);

await mountSidebarSpecimen(ROWS_RECORDS, `/threads/${OPEN_SESSION_ID}`);
await markSheetReady();
