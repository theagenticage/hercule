/**
 * The sidebar specimen: the app's real shell and sidebar, drawn from the
 * records in sidebar-fixture.ts, with the Fix thread open, as the book shows
 * it. `pnpm compare:bureau` compares it pixel for pixel with the sidebar of
 * the Bureau book's session-active.html, edited by sidebar-reference.ts to
 * show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { FIX_THREAD_ID, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { mountSidebarSpecimen } from "./sidebar-page";
import { markSheetReady } from "./sheet-page";

await mountSidebarSpecimen(SPECIMEN_RECORDS, `/threads/${FIX_THREAD_ID}`);
await markSheetReady();
